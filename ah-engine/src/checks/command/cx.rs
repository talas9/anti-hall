//! The context the main-thread decision of command-guard runs in: the payload, the request's settings and environment, and
//! the path questions that depend on them (scratchpad and tmp roots, the project root of a directory).
//!
//! `Unsure` is the one error type: the Node hook would have answered from something the engine cannot see (the hook process's
//! own working directory, a home that is not an absolute path, a git layout the identity port does not classify), so the
//! caller defers to Node rather than guess (D11, D74).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::git::util::Settings;
use crate::checks::guardkit::paths as gp;
use crate::checks::guardkit::settings::{Undecidable, get_setting};
use crate::checks::jsport::{fsx, home, ident};
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// The engine cannot reproduce the Node answer exactly: defer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsure;

/// A result that may be [`Unsure`].
pub type R<T> = Result<T, Unsure>;

impl From<Undecidable> for Unsure {
    fn from(_: Undecidable) -> Unsure {
        Unsure
    }
}

/// Everything one main-thread decision reads.
pub struct Cx<'a> {
    /// The hook payload.
    pub payload: &'a Value,
    /// The request's settings view (environment and home).
    pub st: &'a Settings,
    /// The request's environment.
    pub env: &'a RequestEnv,
    /// The plugin root the engine runs from (empty when unknown).
    pub plugin_root: &'a str,
}

/// The working directory a path question runs against: the payload's (or one a `cd` in the command set), and whether an
/// earlier `cd` left it unknown.
#[derive(Clone, Debug)]
pub struct Pcx {
    /// The directory (`payload.cwd`), `None` when the payload has none.
    pub cwd: Option<String>,
    /// A preceding `cd` that could not be resolved: a relative path is unknowable.
    pub unknown: bool,
    /// Only the session's own scratchpad counts (not the tmp roots).
    pub own_only: bool,
}

impl Pcx {
    /// The context of the payload's own directory.
    pub fn of(cx: &Cx<'_>) -> Pcx {
        Pcx { cwd: cx.payload_cwd().map(str::to_string), unknown: false, own_only: false }
    }

    /// `(payload.cwd string) || process.cwd()`: the engine cannot see the hook's working directory, so it is unsure when
    /// the payload has none (or a relative one).
    pub fn base(&self) -> R<String> {
        match &self.cwd {
            Some(c) if gp::is_absolute(c) => Ok(c.clone()),
            _ => Err(Unsure),
        }
    }
}

impl<'a> Cx<'a> {
    /// `payload.cwd` when it is a non-empty string.
    pub fn payload_cwd(&self) -> Option<&'a str> {
        self.payload.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty())
    }

    /// The value of a boolean-or-enum setting as `settings.get(section, key)` answers it (`None` for `undefined`).
    pub fn setting(&self, key: &str) -> R<Option<Value>> {
        Ok(get_setting(self.st, defaults::raw(key), None, self.plugin_root)?)
    }

    /// `settingsGet(section, key) !== false`.
    pub fn setting_not_false(&self, key: &str) -> R<bool> {
        Ok(self.setting(key)? != Some(Value::Bool(false)))
    }

    /// `settingsGet(section, key) === true`.
    pub fn setting_true(&self, key: &str) -> R<bool> {
        Ok(self.setting(key)? == Some(Value::Bool(true)))
    }

    /// `io.homeOf(env)`: `HOME` else `USERPROFILE`; unsure when there is none (Node would ask the system).
    pub fn home(&self) -> R<&'a str> {
        if self.st.home.is_empty() { Err(Unsure) } else { Ok(self.st.home.as_str()) }
    }

    /// `hookHomeRaw()`: the home directory as the hook sees it, `""` when it cannot tell.
    pub fn home_raw(&self) -> &'a str {
        self.st.home.as_str()
    }
}

/// `os.tmpdir()` then the fixed roots, without duplicates (`scratchpad.js` `tmpRoots`).
pub fn tmp_roots(env: &RequestEnv) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    let mut add = |r: String| {
        if !r.is_empty() && !roots.contains(&r) {
            roots.push(r);
        }
    };
    let tmpdir =
        defaults::list("command.tmp_env_names").into_iter().find_map(|n| env.get(n).filter(|v| !v.is_empty())).unwrap_or(defaults::text("command.tmp_default"));
    add(if tmpdir.len() > 1 && tmpdir.ends_with('/') { tmpdir[..tmpdir.len() - 1].to_string() } else { tmpdir.to_string() });
    for r in defaults::list("command.tmp_fixed_roots") {
        add(r.to_string());
    }
    roots
}

/// The session's own scratchpad directories under every tmp root (`scratchpad.js` `ownScratchpadDirs`); `cwd` is the
/// payload's directory (it names the directory only when the payload carries no transcript path).
pub fn own_scratchpad_dirs(payload: &Value, cwd: Option<&str>, env: &RequestEnv) -> Vec<String> {
    let sid_re = crate::checks::lit_re(r"^[A-Za-z0-9._-]+$");
    let Some(sid) = payload.get("session_id").and_then(Value::as_str).filter(|s| sid_re.is_match(s)) else { return Vec::new() };
    let uid = home::uid();
    let seg_re = crate::checks::lit_re(r"^[A-Za-z0-9-]+$");
    let from_transcript = payload
        .get("transcript_path")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty() && gp::is_absolute(t))
        .map(|t| gp::basename(&crate::checks::git::util::posix_dirname(t)).to_string())
        .filter(|s| !s.is_empty() && seg_re.is_match(s));
    let sanitized = match from_transcript {
        Some(s) => s,
        None => match cwd.filter(|c| !c.is_empty() && gp::is_absolute(c)) {
            Some(c) => c.chars().map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' }).collect::<String>(),
            None => return Vec::new(),
        },
    };
    if sanitized.is_empty() {
        return Vec::new();
    }
    let prefix = defaults::text("command.scratch_uid_prefix");
    let leaf = defaults::text("command.scratch_leaf");
    tmp_roots(env).iter().map(|root| gp::join(root, &format!("{prefix}{uid}/{sanitized}/{sid}/{leaf}"))).collect()
}

impl Cx<'_> {
    /// `isScratchpadOrTmpPath(p, ctx)`.
    pub fn is_scratch_or_tmp(&self, p: &str, pc: &Pcx) -> R<bool> {
        let unq = strip_edge_quotes(p);
        if unq.is_empty() || unq.contains(['$', '`', '~', '*', '?', '[', ']', '{', '}']) {
            return Ok(false);
        }
        if pc.unknown && !gp::is_absolute(unq) {
            return Ok(false);
        }
        let abs = if gp::is_absolute(unq) { gp::resolve_abs(unq) } else { gp::resolve(&pc.base()?, unq) };
        let mut roots = own_scratchpad_dirs(self.payload, pc.cwd.as_deref(), self.env);
        if !pc.own_only {
            roots.extend(tmp_roots(self.env));
        }
        Ok(roots.iter().any(|r| fsx::is_inside_dir(&abs, r)))
    }
}

/// `p.replace(/^['"]|['"]$/g, '')`: one quote character off each end.
pub fn strip_edge_quotes(p: &str) -> &str {
    let p = p.strip_prefix(['\'', '"']).unwrap_or(p);
    p.strip_suffix(['\'', '"']).unwrap_or(p)
}

/// What `projectRootResolver(payload)`'s `rootOf(cwd)` answers: the git toplevel (real path) and the base directory.
#[derive(Clone, Debug)]
pub struct Root {
    /// The git toplevel of the directory, made real.
    pub toplevel: Option<String>,
    /// The toplevel, else the directory (or the payload's start directory for a directory that is not one).
    pub base: String,
}

/// The resolver `projectRootResolver` builds: answers are memoized per directory.
pub struct Roots<'a> {
    cx: &'a Cx<'a>,
    start: String,
    memo: std::cell::RefCell<std::collections::HashMap<String, Root>>,
}

impl<'a> Roots<'a> {
    /// A resolver for the payload's directory (`start`, made real).
    pub fn new(cx: &'a Cx<'a>) -> R<Roots<'a>> {
        let cwd = cx.payload_cwd().filter(|c| gp::is_absolute(c)).ok_or(Unsure)?;
        let start = fsx::realpath_or_self(&gp::resolve_abs(cwd));
        Ok(Roots { cx, start, memo: Default::default() })
    }

    /// `rootOf(cwd)`.
    pub fn of(&self, cwd: &str) -> R<Root> {
        if let Some(r) = self.memo.borrow().get(cwd) {
            return Ok(r.clone());
        }
        let c = ident::resolve_context(cwd, true, self.cx.env);
        if c.unsure {
            return Err(Unsure);
        }
        let toplevel = c.toplevel.map(|t| fsx::realpath_or_self(&t));
        let base = match &toplevel {
            Some(t) => t.clone(),
            None if cwd == self.start => cwd.to_string(),
            None => self.of(&self.start)?.base,
        };
        let r = Root { toplevel, base };
        self.memo.borrow_mut().insert(cwd.to_string(), r.clone());
        Ok(r)
    }
}
