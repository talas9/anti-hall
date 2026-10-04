//! Built-in checks: real logic that a regex rule cannot express (D29, D30).
//!
//! A rule names a check (`"check": "git"`); the engine looks it up in the registry here and runs it on the
//! hook payload. Adding a check means implementing [`Check`] in its own module and listing it in
//! [`registry`]; nothing else in the engine changes.
//!
//! Why a trait plus a registry instead of a `match` on names: rules refer to checks by name from data
//! files, so the set of valid names must be discoverable at runtime (rule validation, `docs`, `status`).
pub mod git;
pub mod guardkit;
pub mod merge_side_pick;
pub mod ship_it;

use crate::rules::Subject;
use serde_json::Value;

/// What a check decided about one payload.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Nothing to say.
    Allow,
    /// Refuse: exit code 2 with this reason on stderr (the way the Node guards block).
    Block(String),
    /// Exit 0 with this stdout JSON line, no decision.
    Advisory(String),
    /// The Node guard may decide differently (for example a Jev consult would run): the engine answers with a
    /// deferral and the client runs the Node hook, so a deferral is never a silent allow (D11).
    Defer,
}

/// A built-in check.
pub trait Check: Send + Sync {
    /// Stable name used in rules (`"check": "<name>"`) and in `docs`.
    fn name(&self) -> &'static str;
    /// One line for the generated reference.
    fn summary(&self) -> &'static str;
    /// Run on a payload. `None` means the check does not apply to this event or tool; `opts` is the rule's
    /// free-form `options` object.
    fn run(&self, subject: &Subject<'_>, opts: &Value) -> Option<Verdict>;
    /// Like [`Check::run`] but also given the whole hook payload, for checks that need fields a [`Subject`] does not
    /// carry (`session_id`, `transcript_path`, `agent_id`, `tool_use_id`, the exact event name). The dispatcher calls
    /// this one; a check that needs only the subject keeps this default.
    fn run_payload(&self, subject: &Subject<'_>, _payload: &Value, opts: &Value) -> Option<Verdict> {
        self.run(subject, opts)
    }
}

/// Compile a regular expression that is a literal in this source.
///
/// Why this exists instead of `Regex::new(..).unwrap()` at every call site: the pattern is fixed text compiled
/// the first time its code path runs, so a failure is a bug in the source, not a runtime condition. The tests that
/// exercise each code path compile every such pattern, so an invalid one fails the build, not a user.
pub(crate) fn lit_re(pattern: &str) -> regex::Regex {
    regex::Regex::new(pattern).unwrap_or_else(|e| panic!("{}: {e}", crate::defaults::text("msg.regex_literal_invalid")))
}

/// Every built-in check, in a fixed order.
pub fn registry() -> &'static [&'static dyn Check] {
    static ALL: [&dyn Check; 3] = [&git::GitGuard, &merge_side_pick::MergeSidePick, &ship_it::ShipItGuard];
    &ALL
}

/// Look a check up by its rule name.
pub fn get(name: &str) -> Option<&'static dyn Check> {
    registry().iter().copied().find(|c| c.name() == name)
}

/// `ah-engine check <name>`: run one check in-process on a hook payload from stdin and print what the Node guard
/// would (exit 2 + stderr for a block, a stdout JSON line for an advisory, `AHFALLBACK` for a deferral). The
/// parity harness drives this to compare a Rust check with its Node original without a daemon.
pub fn cli_main(name: &str) -> i32 {
    use std::io::{Read, Write};
    let Some(check) = get(name) else {
        let _ = writeln!(std::io::stderr(), "{}", crate::defaults::render("msg.err_unknown_check", &[("name", &format!("{name:?}"))]));
        return 64;
    };
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    // A payload serde_json cannot read (e.g. a lone surrogate escape, which JS accepts) is answered by the daemon
    // with ERR, so the client runs the Node hook; report that deferral here too.
    let Ok(p) = serde_json::from_str::<Value>(&raw) else {
        let _ = writeln!(std::io::stdout(), "{}", crate::hookio::FALLBACK);
        return 0;
    };
    let null = Value::Null;
    let subject = Subject {
        event: p.get("hook_event_name").and_then(Value::as_str).unwrap_or("PreToolUse"),
        tool: p.get("tool_name").and_then(Value::as_str),
        cwd: p.get("cwd").and_then(Value::as_str),
        tool_input: p.get("tool_input").unwrap_or(&null),
        prompt: p.get("prompt").and_then(Value::as_str),
    };
    match check.run_payload(&subject, &p, &Value::Null) {
        None | Some(Verdict::Allow) => 0,
        Some(Verdict::Block(m)) => {
            let _ = writeln!(std::io::stderr(), "{m}");
            2
        }
        Some(Verdict::Advisory(j)) => {
            let _ = writeln!(std::io::stdout(), "{j}");
            0
        }
        Some(Verdict::Defer) => {
            let _ = writeln!(std::io::stdout(), "{}", crate::hookio::FALLBACK);
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_names_are_unique_and_resolvable() {
        let names: Vec<&str> = registry().iter().map(|c| c.name()).collect();
        for n in &names {
            assert_eq!(names.iter().filter(|x| *x == n).count(), 1, "duplicate check {n}");
            assert!(get(n).is_some());
        }
        assert!(get("nope").is_none());
    }
}
