//! Running git for a cache miss: bounded, quiet, and in its own process group.
use super::layout::Layout;
use super::{GitCacheError, GitLimits};
use crate::defaults;
use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::Instant;

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
        let mut cmd = Command::new(defaults::text("gitcache.git_binary"));
        cmd.args(args).current_dir(self.work_dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0);
        for a in defaults::list("gitcache.run_env") {
            if let Some((k, v)) = a.split_once('=') {
                cmd.env(k, v);
            }
        }
        for (k, v) in self.env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().map_err(fail)?;
        let pid = child.id() as i32;
        let mut out = child.stdout.take().ok_or_else(|| fail(std::io::Error::other("no stdout")))?;
        let reader = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = out.read_to_end(&mut b);
            b
        });
        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) if start.elapsed() < self.lim.timeout => std::thread::sleep(self.lim.poll),
                Ok(None) => {
                    // the whole group: a git that spawned a helper must not leave it running (D9)
                    unsafe { libc::kill(-pid, libc::SIGKILL) };
                    let _ = child.wait();
                    let _ = reader.join();
                    return Err(fail(std::io::Error::from(std::io::ErrorKind::TimedOut)));
                }
                Err(e) => return Err(fail(e)),
            }
        };
        let bytes = reader.join().unwrap_or_default();
        Ok(status.success().then(|| String::from_utf8_lossy(&bytes).to_string()))
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
