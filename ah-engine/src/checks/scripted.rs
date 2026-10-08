//! The registry entry of a check whose decision logic is a plugin script (D88). It holds a name and a summary and NO
//! decision: the script (`engine/logic/<name>.js`) answers in [`run_env_guarded`](super::run_env_guarded), and this entry
//! answers only when the script is missing or scripts are switched off, which is the script-failure policy
//! ([`crate::script::failed`]): defer to the Node hook, or the engine-only safe outcome.
use super::{Check, Verdict};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

/// One scripted check: its registry name and the defaults key of its one-line summary.
pub struct Scripted {
    name: &'static str,
    summary_key: &'static str,
}

impl Scripted {
    /// A registry entry for the check `name`.
    pub const fn new(name: &'static str, summary_key: &'static str) -> Scripted {
        Scripted { name, summary_key }
    }
}

impl Check for Scripted {
    fn name(&self) -> &'static str {
        self.name
    }

    fn summary(&self) -> &'static str {
        crate::defaults::text(self.summary_key)
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, _payload: &Value, _opts: &Value, _env: &RequestEnv) -> Option<Verdict> {
        crate::script::missing(self.name, s.event)
    }

    fn scripted(&self) -> bool {
        true
    }
}

/// `api-guard` (PreToolUse on Write, Edit, MultiEdit, Bash; apply_patch for Codex).
pub static API_GUARD: Scripted = Scripted::new("api-guard", "api_guard.summary");

/// `inbox-read-guard` (PreToolUse on Read).
pub static INBOX_READ_GUARD: Scripted = Scripted::new("inbox-read-guard", "inbox_read.summary");

/// `orch-on-spawn` (PreToolUse on Agent, Task, Workflow; Codex's spawn tool).
pub static ORCH_ON_SPAWN: Scripted = Scripted::new("orch-on-spawn", "orch_on_spawn.summary");

/// `verify-first-subagent` (SubagentStart).
pub static VERIFY_FIRST_SUBAGENT: Scripted = Scripted::new("verify-first-subagent", "verify_first.summary_subagent");

/// `verify-first-full` (SessionStart).
pub static VERIFY_FIRST_FULL: Scripted = Scripted::new("verify-first-full", "verify_first.summary_full");

/// `fable-availability` (SessionStart).
pub static FABLE_AVAILABILITY: Scripted = Scripted::new("fable-availability", "fable_availability.summary");

/// `edit-guard` (PreToolUse on Edit, Write, MultiEdit, NotebookEdit; apply_patch for Codex).
pub static EDIT_GUARD: Scripted = Scripted::new("edit-guard", "edit_guard.summary");
