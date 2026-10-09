//! Running git for a cache miss: bounded, quiet, and in its own process group.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - a panicked or timed-out helper yields no output; the caller treats that as no answer
// A failure that must be seen goes through `crate::discard` instead.

use super::layout::Layout;
use super::{GitCacheError, GitLimits};
use crate::defaults;
use std::collections::BTreeMap;
use std::process::Command;

/// Runs git inside one repository's work tree.
pub(super) struct Runner<'a> {
    work_dir: &'a std::path::Path,
    env: &'a [(String, String)],
    lim: &'a GitLimits,
}

impl<'a> Runner<'a> {
    pub(super) fn new(layout: &'a Layout, env: &'a [(String, String)], lim: &'a GitLimits) -> Runner<'a> {
        Runner { work_dir: &layout.work_dir, env, lim }
    }

    /// `Ok(Some(stdout))` when git exited 0, `Ok(None)` when it exited non-zero, `Err` when it could not be run to
    /// completion (never cached).
    pub(super) fn run(&self, args: &[&str]) -> Result<Option<String>, GitCacheError> {
        let shown = args.join(" ");
        let fail = |source: std::io::Error| GitCacheError::Run { args: shown.clone(), source };
        let mut cmd = Command::new(&self.lim.git_binary);
        cmd.args(args).current_dir(self.work_dir);
        for a in defaults::list("gitcache.run_env") {
            if let Some((k, v)) = a.split_once('=') {
                cmd.env(k, v);
            }
        }
        // git must see the caller's git environment only: the daemon's own GIT_* (it was started by some other client)
        // would change where git looks, and the bypass check never saw it
        for name in defaults::list("gitcache.bypass_env") {
            cmd.env_remove(name);
        }
        for (k, v) in self.env {
            cmd.env(k, v);
        }
        // never past the time the daemon's client still waits (review finding 4); a timed-out run is never cached. The run
        // is bounded end to end: its group is killed on timeout and a leftover holding stdout cannot hang it (findings 7, 8)
        let timeout = crate::deadline::clamp(self.lim.timeout);
        let o = crate::proc::run(cmd, &self.lim.git_binary, timeout, self.lim.poll).map_err(|e| fail(e.into_io()))?;
        Ok(o.status.success().then(|| String::from_utf8_lossy(&o.stdout).to_string()))
    }
}

/// Drop one trailing newline, the way a shell's command substitution would not (it drops all; git prints one).
pub(super) fn strip_newline(s: &str) -> String {
    s.strip_suffix('\n').unwrap_or(s).to_string()
}

/// `lib/git-alias-scan.js` `aliasesFor`: NUL-separated `name\nvalue` records; a leading `alias.` is removed, names
/// are lower-cased and the first definition of a name wins.
pub(super) fn parse_aliases(out: &str) -> BTreeMap<String, String> {
    let prefix = defaults::text("gitcache.alias_prefix");
    let mut map = BTreeMap::new();
    for rec in out.split('\0') {
        let Some(nl) = rec.find('\n') else { continue };
        if nl == 0 {
            continue;
        }
        let mut name = &rec[..nl];
        if name.len() >= prefix.len() && name.is_char_boundary(prefix.len()) && name[..prefix.len()].eq_ignore_ascii_case(prefix) {
            name = &name[prefix.len()..];
        }
        let name = name.to_lowercase();
        if !name.is_empty() {
            map.entry(name).or_insert_with(|| rec[nl + 1..].to_string());
        }
    }
    map
}
