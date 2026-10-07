//! Built-in `check = "inbox-read-guard"`: a port of the Node inbox-read-guard (PreToolUse on Read).
//!
//! The guard blocks a Read-tool read of the raw DevSwarm inbox, which must only be read through the wrapper (the durable
//! cursor would be bypassed). It is dormant unless DevSwarm is active. Everything the Node guard decides without running
//! Node code is decided here, byte for byte: the switch, the skip file, DevSwarm detection, the path taxonomy and the
//! block message. One case is not: a path inside the raw store only blocks when the wrapper's store-read command exists,
//! which the Node guard finds by loading a module; that case defers to Node, so a store read is never decided on a guess.
//!
//! Mirrors `hooks/inbox-read-guard.js` and `hooks/lib/devswarm-inbox-paths.js` `classifyDevswarmPath`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::paths::{is_absolute, join, resolve_abs};
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::spawnctx::{devswarm_active, os_homedir};
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

#[cfg(test)]
mod tests;

/// What the path taxonomy says about one path.
#[derive(Debug, PartialEq, Eq)]
pub enum Class {
    /// Not a raw surface.
    Allow,
    /// A raw inbox file: blocked.
    Inbox,
    /// A raw store file: blocked only when the wrapper can serve store reads (decided by Node).
    Store,
}

/// `isStoreDenyTarget(rest)`: the store-relative path is the database, a sidecar or a journal file.
fn is_store_target(rest: &str) -> bool {
    static RES: std::sync::OnceLock<Vec<regex::Regex>> = std::sync::OnceLock::new();
    RES.get_or_init(|| defaults::list("inbox_read.store_patterns").into_iter().map(|p| jsre::compile(p, false)).collect()).iter().any(|re| re.is_match(rest))
}

/// `s.replace(/\\/g, '/').replace(/\/+$/, '')`.
fn slashes(s: &str) -> String {
    s.replace('\\', "/").trim_end_matches('/').to_string()
}

/// `classifyDevswarmPath(rawPath, home, cwd)` with the store gate left open. `None`: Node would resolve a relative path
/// against its own working directory, which the engine cannot see.
pub fn classify(raw_path: &str, home: &str, cwd: Option<&str>) -> Option<Class> {
    if raw_path.is_empty() {
        return Some(Class::Allow);
    }
    let abs = if is_absolute(raw_path) {
        raw_path.to_string()
    } else {
        let base = match cwd {
            Some(c) if !c.is_empty() => c,
            _ => home,
        };
        if !is_absolute(base) {
            return None;
        }
        resolve_abs(&format!("{base}/{raw_path}"))
    };
    let n_abs = slashes(&abs);
    let n_root = slashes(&join(home, defaults::text("inbox_read.devswarm_root")));
    let rel = if n_abs == n_root {
        return Some(Class::Allow);
    } else if let Some(r) = n_abs.strip_prefix(&format!("{n_root}/")) {
        r
    } else {
        return Some(Class::Allow);
    };
    if rel.is_empty() {
        return Some(Class::Allow);
    }
    let seg = rel.split('/').next().unwrap_or("");
    if seg == defaults::text("inbox_read.inbox_segment") {
        return Some(Class::Inbox);
    }
    if seg == defaults::text("inbox_read.store_segment") {
        let rest = rel.get(seg.len() + 1..).unwrap_or("");
        return Some(if is_store_target(rest) { Class::Store } else { Class::Allow });
    }
    Some(Class::Allow)
}

/// The block the guard writes: the JSON decision on stdout only, exit 2.
fn block() -> Verdict {
    let reason = msg::message(
        Kind::Block,
        defaults::text("inbox_read.guard_inbox"),
        &Parts {
            what: defaults::text("inbox_read.msg_inbox_what"),
            why: defaults::text("inbox_read.msg_inbox_why"),
            instead: defaults::text("inbox_read.msg_inbox_instead"),
            override_: defaults::text("inbox_read.msg_override"),
            ..Parts::default()
        },
    );
    let quoted = serde_json::to_string(&reason).unwrap_or_else(|_| String::from("\"\""));
    Verdict::Exact(Exact { code: 2, out: format!("{{\"decision\":\"block\",\"reason\":{quoted}}}\n"), err: String::new() })
}

/// The check's decision on one payload. `None`: nothing to say.
///
/// Mirrors `hooks/inbox-read-guard.js` `main`.
pub fn decide(p: &Value, st: &Settings) -> Option<Verdict> {
    let Some(home) = os_homedir(&st.env) else { return Some(Verdict::Defer) };
    if !get_bool(st, defaults::raw("inbox_read.setting")) || is_skipped(st, defaults::text("inbox_read.skip_name")) || !devswarm_active(st) {
        return None;
    }
    if p.get("tool_name").and_then(Value::as_str) != Some(defaults::text("inbox_read.tool")) {
        return None;
    }
    let file_path = match p.get("tool_input").and_then(|t| t.get("file_path")) {
        Some(Value::String(s)) => s.as_str(),
        _ => return None,
    };
    let cwd = p.get("cwd").and_then(Value::as_str);
    match classify(file_path, &home, cwd) {
        None => Some(Verdict::Defer),
        Some(Class::Allow) => None,
        Some(Class::Inbox) => Some(block()),
        Some(Class::Store) => Some(Verdict::Defer),
    }
}

/// The registered `inbox-read-guard` check.
pub struct InboxReadGuard;

impl Check for InboxReadGuard {
    fn name(&self) -> &'static str {
        "inbox-read-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("inbox_read.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        (s.tool == Some(defaults::text("inbox_read.tool"))).then_some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        decide(payload, &Settings::from_env(env)).or(Some(Verdict::Allow))
    }
}
