//! The agents as a hierarchy: each agent gets the project it works in, and the links a flat tracker list lacks (a workspace or a Codex
//! row under its project's Primary, a stand-in row for a parent that a sub-agent names but the tracker does not list). The page only
//! nests what it is given; every folder name, kind and text here is a setting of `web.toml`.
use crate::cfg::Settings;
use ah_web_proto::Agent;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::Mutex;

static ROOTS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// The top folder of the project `path` belongs to: the git checkout it is in (for a linked worktree or a submodule, the repository
/// they point at); for a folder that no longer exists, the workspace checkout its path names; else the folder itself. Empty for no path.
fn root_of(s: &Settings, home: &str, path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    let mut cache = ROOTS.lock().unwrap_or_else(|p| p.into_inner());
    let map = cache.get_or_insert_with(HashMap::new);
    if let Some(r) = map.get(path) {
        return r.clone();
    }
    if map.len() >= s.project_cache_max {
        map.clear();
    }
    let root = find_root(s, home, path);
    map.insert(path.to_string(), root.clone());
    root
}

fn find_root(s: &Settings, home: &str, path: &str) -> String {
    let mut cur = Some(Path::new(path));
    while let Some(dir) = cur {
        // the home folder is a project only when it is the agent's own folder
        if dir.as_os_str() != home || dir == Path::new(path) {
            let git = dir.join(&s.project_git_entry);
            if git.is_dir() {
                return dir.display().to_string();
            }
            if git.is_file() {
                let pointed = std::fs::read_to_string(&git).ok().and_then(|t| t.trim().strip_prefix("gitdir:").map(|r| r.trim().to_string()));
                // the pointer may be relative to the folder that holds the file
                let pointed = pointed.map(|p| if Path::new(&p).is_absolute() { p } else { clean(&dir.join(&p)) });
                return match pointed.as_deref().and_then(|p| p.find(&s.project_gitdir_split).map(|i| &p[..i])) {
                    Some(repo) if !repo.is_empty() => repo.to_string(),
                    _ => dir.display().to_string(),
                };
            }
        }
        cur = dir.parent().filter(|p| p.parent().is_some());
    }
    // a checkout that is gone: the workspace folder its path names (marker, then the two ids, then the workspace)
    if let Some(i) = path.find(&s.project_workspace_marker) {
        let after = &path[i + s.project_workspace_marker.len()..];
        let keep: Vec<&str> = after.split('/').take(3).collect();
        return format!("{}{}", &path[..i + s.project_workspace_marker.len()], keep.join("/"));
    }
    path.to_string()
}

/// A path with its `.` and `..` steps worked out (no file system access).
fn clean(path: &Path) -> String {
    use std::path::Component;
    let mut out = std::path::PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out.display().to_string()
}

fn base(path: &str) -> &str {
    path.rsplit('/').find(|p| !p.is_empty()).unwrap_or_default()
}

fn is_workspace_row(s: &Settings, a: &Agent) -> bool {
    a.project.contains(&s.project_workspace_marker) && s.project_workspace_kinds.contains(&a.kind)
}

/// Give every agent its project, then fill the missing links. The list keeps its order; stand-in parents are added at the end.
pub fn link(s: &Settings, agents: &mut Vec<Agent>) {
    let home = std::env::var("HOME").unwrap_or_default();
    for a in agents.iter_mut() {
        a.project_root = root_of(s, &home, &a.project);
        a.project_name = if a.project_root.is_empty() {
            s.project_none_label.clone()
        } else if a.project_root == home {
            s.project_home_label.clone()
        } else {
            base(&a.project_root).to_string()
        };
    }
    // a project's Primary: the agent of a primary kind and role that is not itself inside a workspace checkout
    let mut primary: BTreeMap<String, String> = BTreeMap::new();
    for a in agents.iter().filter(|a| !a.project_root.is_empty() && a.role == s.project_primary_role && s.project_primary_kinds.contains(&a.kind) && !is_workspace_row(s, a)) {
        let slot = primary.entry(a.project_root.clone()).or_insert_with(|| a.id.clone());
        if a.id < *slot {
            *slot = a.id.clone();
        }
    }
    let ids: BTreeSet<String> = agents.iter().map(|a| a.id.clone()).collect();
    // workspace rows by directory, so a Codex row finds the workspace it runs in
    let workspaces: Vec<(String, String)> = agents.iter().filter(|a| is_workspace_row(s, a)).map(|a| (a.project.clone(), a.id.clone())).collect();
    for a in agents.iter_mut().filter(|a| a.parent.is_empty()) {
        let root_primary = primary.get(&a.project_root).filter(|p| **p != a.id).cloned();
        if is_workspace_row(s, a) {
            if let Some(p) = root_primary {
                a.parent = p;
            }
        } else if a.kind == "codex" {
            let inside = workspaces.iter().filter(|(dir, id)| *id != a.id && (a.project == *dir || a.project.starts_with(&format!("{dir}/")))).max_by_key(|(dir, _)| dir.len());
            if let Some(w) = inside.map(|(_, id)| id.clone()).or(root_primary) {
                a.parent = w;
            }
        }
    }
    // a parent the tracker does not list stands in as a row of its own, under the Primary of the project its children work in
    let mut stand_in: BTreeMap<String, Agent> = BTreeMap::new();
    for a in agents.iter().filter(|a| !a.parent.is_empty() && !ids.contains(&a.parent)) {
        let entry = stand_in.entry(a.parent.clone()).or_insert_with(|| Agent {
            id: a.parent.clone(),
            label: s.placeholder_label.replace("{id}", &a.parent.chars().take(s.placeholder_id_chars).collect::<String>()),
            kind: s.placeholder_kind.clone(),
            state: s.placeholder_state.clone(),
            parent: primary.get(&a.project_root).cloned().unwrap_or_default(),
            project: a.project.clone(),
            project_root: a.project_root.clone(),
            project_name: a.project_name.clone(),
            placeholder: true,
            ..Agent::default()
        });
        // the freshest child tells how recently the parent was heard from
        if let Some(s) = a.last_output_s {
            entry.last_output_s = Some(entry.last_output_s.map_or(s, |e| e.min(s)));
        }
    }
    agents.extend(stand_in.into_values());
}
