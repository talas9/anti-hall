//! The part of `companion/lib/identity.js` `resolveContext` the hooks of this lane read: the git `toplevel` of a directory
//! and its `worktreeRoot` (the outermost superproject checkout).
//!
//! Pure file-system first, like the original; the one git call it makes (`rev-parse --show-superproject-working-tree`,
//! for a repository nested in another one whose layout cannot be classified from disk) is made here too.
use super::fsx;
use super::gitrun;
use crate::checks::git::util::{posix_dirname, resolve};
use crate::defaults;
use crate::reqenv::RequestEnv;
use std::fs;

/// What the resolver found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ctx {
    /// The nearest checkout (`toplevel`), `None` for no repository, a missing path, or a path inside a gitdir.
    pub toplevel: Option<String>,
    /// The outermost superproject checkout (`worktreeRoot`).
    pub worktree_root: Option<String>,
    /// True when the answer depends on something this port does not reproduce (a relative path, an unusual `.git` file):
    /// the caller defers.
    pub unsure: bool,
}

struct Info {
    g: String,
    is_file: bool,
    common: String,
    has_commondir: bool,
}

fn under(child: &str, parent: &str) -> bool {
    child == parent || child.starts_with(&format!("{parent}/"))
}

fn real(p: &str) -> Option<String> {
    fs::canonicalize(p).ok().map(|r| r.to_string_lossy().into_owned())
}

fn nearest_dot_git(dir: &str) -> Option<String> {
    let mut d = dir.to_string();
    loop {
        if fsx::lexists(&format!("{d}/.git")) {
            return Some(d);
        }
        let parent = posix_dirname(&d);
        if parent == d {
            return None;
        }
        d = parent;
    }
}

/// `gitdir: <path>` of a `.git` file: the first line whose text, after white space, starts with the key.
fn gitdir_of_file(text: &str) -> Option<String> {
    let key = defaults::text("codex_handover.gitdir_key");
    let is_ws = crate::checks::guardkit::text::is_js_space;
    let mut starts = vec![0usize];
    for (i, c) in text.char_indices() {
        if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            starts.push(i + c.len_utf8());
        }
    }
    for p in starts {
        let rest = &text[p..];
        let q = rest.trim_start_matches(is_ws);
        let Some(after) = q.strip_prefix(key) else { continue };
        let after = after.trim_start_matches(is_ws);
        let line = after.split(['\n', '\r', '\u{2028}', '\u{2029}']).next().unwrap_or("");
        let cap = line.trim_end_matches(is_ws);
        if !cap.is_empty() {
            return Some(cap.to_string());
        }
    }
    None
}

fn gitdir_of(t: &str, unsure: &mut bool) -> Option<Info> {
    let dot = format!("{t}/.git");
    let md = fs::symlink_metadata(&dot).ok()?;
    let (g, is_file);
    if md.is_dir() {
        g = real(&dot)?;
        is_file = false;
    } else {
        is_file = true;
        let text = fsx::read_utf8(&dot)?;
        if text.contains(['\r', '\u{2028}', '\u{2029}']) {
            *unsure = true;
        }
        let m = gitdir_of_file(&text)?;
        g = real(&resolve(t, &m, "/"))?;
        if !fsx::is_dir(&g) {
            return None;
        }
    }
    let mut common = g.clone();
    let mut has_commondir = false;
    if let Some(raw) = fsx::read_utf8(&format!("{g}/commondir")) {
        let raw = crate::checks::guardkit::text::js_trim(&raw);
        if !raw.is_empty()
            && let Some(c) = real(&resolve(&g, raw, "/"))
        {
            common = c;
            has_commondir = true;
        }
    }
    Some(Info { g, is_file, common, has_commondir })
}

/// `resolveContext(cwd)` (or with `missingPath: 'ancestor'`).
pub fn resolve_context(cwd: &str, ancestor: bool, env: &RequestEnv) -> Ctx {
    let mut ctx = Ctx::default();
    if !cwd.starts_with('/') {
        ctx.unsure = true; // a relative path resolves against the hook's own working directory, which is not known here
        return ctx;
    }
    let abs = resolve(cwd, "", "/");
    let cwd_real = match real(&abs) {
        Some(r) => r,
        None if !ancestor => return ctx,
        None => {
            let mut d = posix_dirname(&abs);
            loop {
                if let Some(r) = real(&d) {
                    break r;
                }
                let up = posix_dirname(&d);
                if up == d {
                    return ctx;
                }
                d = up;
            }
        }
    };
    let Some(t) = nearest_dot_git(&cwd_real) else { return ctx };
    let Some(info) = gitdir_of(&t, &mut ctx.unsure) else { return ctx };
    if under(&cwd_real, &info.g) {
        return ctx;
    }
    ctx.toplevel = Some(t.clone());
    // worktreeRoot: climb to the outermost superproject.
    let scrub = defaults::list("codex_handover.git_scrub_env");
    let super_of = |root: &str, ri: &Info, unsure: &mut bool| -> Option<String> {
        let p = nearest_dot_git(&posix_dirname(root))?;
        if p == root {
            return None;
        }
        if ri.is_file {
            let pi = gitdir_of(&p, unsure);
            if pi.is_some_and(|pi| ri.g.starts_with(&format!("{}/modules/", pi.g))) {
                return Some(p);
            }
            if ri.has_commondir {
                return None;
            }
        }
        // a `.git` directory (or an unknown file layout) below another repository: ask git
        let argv: Vec<String> = defaults::list("codex_handover.argv_super").iter().map(|a| a.replace("{root}", root)).collect();
        let out = gitrun::git_scrubbed(
            root,
            &argv.iter().map(String::as_str).collect::<Vec<_>>(),
            defaults::millis("codex_handover.identity_git_timeout_ms"),
            env,
            &scrub,
        );
        let s = out?;
        let s = crate::checks::guardkit::text::js_trim(&s);
        if s.is_empty() { None } else { real(s) }
    };
    let (mut root, mut ri) = (t, info);
    for _ in 0..defaults::num("codex_handover.max_submodule_hops") {
        let sp = super_of(&root, &ri, &mut ctx.unsure);
        if sp.is_none() && ri.is_file && ri.has_commondir {
            // A linked worktree of a submodule hops to the submodule checkout named by core.worktree; when the common
            // directory's config names one, this port does not follow it.
            if let Some(cfg) = fsx::read_utf8(&format!("{}/config", ri.common))
                && cfg.lines().any(|l| l.trim_start().starts_with(defaults::text("codex_handover.core_worktree_key")))
            {
                ctx.unsure = true;
            }
        }
        let Some(sp) = sp else { break };
        let Some(spi) = gitdir_of(&sp, &mut ctx.unsure) else { break };
        root = sp;
        ri = spi;
    }
    ctx.worktree_root = Some(root);
    ctx
}
