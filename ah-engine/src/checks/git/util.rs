//! Small helpers other compiled checks share: Node-compatible POSIX path functions and the request's environment snapshot
//! (`Settings`: the home directory and the variables of the hook's own environment). The git guard's block-message builder,
//! child-process runner and settings switches moved into the plugin script (`engine/logic/git.js`) and the host API (D88).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use std::collections::HashMap;

/// Lexical normalization like Node `path.posix.normalize`.
pub fn posix_normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let is_abs = p.starts_with('/');
    let trailing = p.ends_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|l| *l != "..") {
                    out.pop();
                } else if !is_abs {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let mut path = out.join("/");
    if path.is_empty() {
        if is_abs {
            return "/".into();
        }
        return if trailing { "./".into() } else { ".".into() };
    }
    if trailing {
        path.push('/');
    }
    if is_abs { format!("/{path}") } else { path }
}

/// Like Node `path.posix.dirname`.
pub fn posix_dirname(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let has_root = p.starts_with('/');
    let bytes: Vec<char> = p.chars().collect();
    let mut end: isize = -1;
    let mut matched = true;
    let mut i = bytes.len() as isize - 1;
    while i >= 1 {
        if bytes[i as usize] == '/' {
            if !matched {
                end = i;
                break;
            }
        } else {
            matched = false;
        }
        i -= 1;
    }
    if end == -1 {
        return if has_root { "/".into() } else { ".".into() };
    }
    if has_root && end == 1 {
        return "//".into();
    }
    bytes[..end as usize].iter().collect()
}

/// Like Node `path.posix.basename`.
pub fn posix_basename(p: &str) -> String {
    let t = p.trim_end_matches('/');
    t.rsplit('/').next().unwrap_or("").to_string()
}

/// `path.resolve(base, rel)` for a posix path; `cwd` stands in for `process.cwd()`.
pub fn resolve(base: &str, rel: &str, cwd: &str) -> String {
    let mut stack: Vec<&str> = vec![rel, base];
    let mut resolved = String::new();
    let mut abs = false;
    for part in stack.drain(..) {
        if part.is_empty() {
            continue;
        }
        resolved = if resolved.is_empty() { part.to_string() } else { format!("{part}/{resolved}") };
        if part.starts_with('/') {
            abs = true;
            break;
        }
    }
    if !abs {
        resolved = if resolved.is_empty() { cwd.to_string() } else { format!("{cwd}/{resolved}") };
    }
    let n = posix_normalize(&resolved);
    if n.len() > 1 && n.ends_with('/') { n[..n.len() - 1].to_string() } else { n }
}

/// Like Node `path.posix.join`.
pub fn path_join(a: &str, b: &str) -> String {
    if a.is_empty() && b.is_empty() {
        return ".".into();
    }
    let j = if a.is_empty() {
        b.to_string()
    } else if b.is_empty() {
        a.to_string()
    } else {
        format!("{a}/{b}")
    };
    posix_normalize(&j)
}

/// Process environment plus home, read once per request; every switch the Node guard consults resolves through it.
#[derive(Clone)]
pub struct Settings {
    /// The home directory (`HOME`, else `USERPROFILE`).
    pub home: String,
    /// Snapshot of the environment.
    pub env: HashMap<String, String>,
}

impl Settings {
    /// The environment of one request (D76): never the daemon's own.
    pub fn from_env(request_env: &crate::reqenv::RequestEnv) -> Settings {
        let env: HashMap<String, String> = request_env.to_map();
        let home = env.get(crate::defaults::env_name("home")).cloned().or_else(|| env.get(crate::defaults::env_name("home_alt")).cloned()).unwrap_or_default();
        Settings { home, env }
    }
}
