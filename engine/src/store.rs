//! Project-partitioned state. Every operation is keyed by a project key that the DAEMON derives from the
//! request's `cwd` (nearest ancestor holding `.git`, else the cwd itself); a request cannot name another
//! project's key, so project A has no path to project B's mailbox or values.
use std::collections::{HashMap, VecDeque};
use std::path::Path;

const MAX_PROJECTS: usize = 256;
const MAILBOX_CAP: usize = 64;
const KV_CAP: usize = 64;
const VALUE_CAP: usize = 64 * 1024;

/// Lexical normalization: collapse `.`/`..`/repeated slashes. Does not touch the filesystem.
pub fn normalize(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for c in p.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            c => parts.push(c),
        }
    }
    format!("/{}", parts.join("/"))
}

/// Project key for a cwd: the nearest ancestor containing a `.git` entry, else the normalized cwd.
pub fn project_key(cwd: &str) -> String {
    let n = normalize(cwd);
    let mut cur = n.as_str();
    loop {
        if Path::new(cur).join(".git").symlink_metadata().is_ok() {
            return cur.to_string();
        }
        match cur.rfind('/') {
            Some(0) | None => return n,
            Some(i) => cur = &cur[..i],
        }
    }
}

/// Bounded cwd -> key cache so the hot path does not stat per request.
#[derive(Default)]
pub struct KeyCache(HashMap<String, String>);

impl KeyCache {
    pub fn key(&mut self, cwd: &str) -> String {
        if let Some(k) = self.0.get(cwd) {
            return k.clone();
        }
        if self.0.len() >= 1024 {
            self.0.clear();
        }
        let k = project_key(cwd);
        self.0.insert(cwd.to_string(), k.clone());
        k
    }
}

#[derive(Default)]
struct Project {
    mailbox: VecDeque<String>,
    kv: HashMap<String, String>,
}

#[derive(Default)]
pub struct Store {
    projects: HashMap<String, Project>,
}

impl Store {
    pub fn projects(&self) -> usize {
        self.projects.len()
    }

    /// Run `verb` against the partition `key`. Verbs: `put <text>`, `take`, `len`, `set <k> <v>`, `get <k>`.
    pub fn op(&mut self, key: &str, verb: &str, args: &str) -> Result<String, String> {
        if !self.projects.contains_key(key) {
            if matches!(verb, "take" | "len" | "get") {
                return Ok(if verb == "len" { "0".into() } else { String::new() }); // reads never allocate a partition
            }
            if self.projects.len() >= MAX_PROJECTS {
                return Err("too many projects".into());
            }
        }
        if args.len() > VALUE_CAP {
            return Err("value too large".into());
        }
        let p = self.projects.entry(key.to_string()).or_default();
        match verb {
            "put" => {
                if p.mailbox.len() >= MAILBOX_CAP {
                    return Err("mailbox full".into());
                }
                p.mailbox.push_back(args.to_string());
                Ok("ok".into())
            }
            "take" => Ok(p.mailbox.pop_front().unwrap_or_default()),
            "len" => Ok(p.mailbox.len().to_string()),
            "set" => {
                let (k, v) = args.split_once(' ').unwrap_or((args, ""));
                if !p.kv.contains_key(k) && p.kv.len() >= KV_CAP {
                    return Err("too many keys".into());
                }
                p.kv.insert(k.to_string(), v.to_string());
                Ok("ok".into())
            }
            "get" => Ok(p.kv.get(args.trim()).cloned().unwrap_or_default()),
            v => Err(format!("unknown verb {v:?}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_is_lexical() {
        assert_eq!(normalize("/a/b/../c/./d//e"), "/a/c/d/e");
        assert_eq!(normalize("/../.."), "/");
    }

    #[test]
    fn project_a_cannot_read_project_b() {
        let base = std::env::temp_dir().join(format!("ah-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        for p in ["A/.git", "A/sub/deep", "B/.git", "A-evil"] {
            std::fs::create_dir_all(base.join(p)).unwrap();
        }
        let b = base.to_str().unwrap();
        let mut kc = KeyCache::default();
        let (ka, ka2, kb, ke) = (
            kc.key(&format!("{b}/A")),
            kc.key(&format!("{b}/A/sub/deep")),
            kc.key(&format!("{b}/A/../B")),
            kc.key(&format!("{b}/A-evil")),
        );
        assert_eq!(ka, ka2, "a subdirectory belongs to its repo");
        assert_ne!(ka, kb);
        assert_ne!(ka, ke, "a sibling sharing a name prefix is a different project");
        let mut s = Store::default();
        s.op(&ka, "put", "secret for A").unwrap();
        s.op(&ka, "set", "token a-only").unwrap();
        assert_eq!(s.op(&kb, "take", "").unwrap(), "");
        assert_eq!(s.op(&kb, "get", "token").unwrap(), "");
        assert_eq!(s.op(&ke, "take", "").unwrap(), "");
        assert_eq!(s.op(&kb, "len", "").unwrap(), "0");
        assert_eq!(s.projects(), 1, "reading another project does not create a partition");
        assert_eq!(s.op(&ka2, "get", "token").unwrap(), "a-only");
        assert_eq!(s.op(&ka2, "take", "").unwrap(), "secret for A");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn caps_hold() {
        let mut s = Store::default();
        for i in 0..MAILBOX_CAP {
            s.op("/p", "put", &i.to_string()).unwrap();
        }
        assert!(s.op("/p", "put", "x").is_err());
        for i in 0..MAX_PROJECTS {
            s.op(&format!("/q{i}"), "put", "x").ok();
        }
        assert!(s.projects() <= MAX_PROJECTS);
    }
}
