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

/// `ship-it-guard` (PreToolUse on Write, Edit, MultiEdit, NotebookEdit; Bash and apply_patch defer to Node).
pub static SHIP_IT_GUARD: Scripted = Scripted::new("ship-it-guard", "ship_it.summary");

/// `compact-declaration-guard` (PreToolUse).
pub static COMPACT_DECLARATION_GUARD: Scripted = Scripted::new("compact-declaration-guard", "compact_decl.summary");

/// `devswarm-parent-inbox` (UserPromptSubmit).
pub static DEVSWARM_PARENT_INBOX: Scripted = Scripted::new("devswarm-parent-inbox", "devswarm_prompt.parent_summary");

/// `devswarm-child-turn` (UserPromptSubmit).
pub static DEVSWARM_CHILD_TURN: Scripted = Scripted::new("devswarm-child-turn", "devswarm_prompt.child_summary");

/// `swarm-guard` (PreToolUse on Agent and Task; the anti fork bomb).
pub static SWARM_GUARD: Scripted = Scripted::new("swarm-guard", "swarm_guard.summary");

/// `git` (PreToolUse on Bash): the git guard.
pub static GIT_GUARD: Scripted = Scripted::new("git", "git.check_summary");

/// `git-audit` (PostToolUse on Bash): the audit pass of the git guard.
pub static GIT_AUDIT: Scripted = Scripted::new("git-audit", "git_audit.summary");

/// `dispatch-tier`.
pub static DISPATCH_TIER: Scripted = Scripted::new("dispatch-tier", "dispatch_tier.summary");

/// `model-routing`.
pub static MODEL_ROUTING: Scripted = Scripted::new("model-routing", "model_routing.summary");

/// `speculation-judge`.
pub static SPECULATION_JUDGE: Scripted = Scripted::new("speculation-judge", "speculation_judge.summary");

/// `speculation-guard`.
pub static SPECULATION_GUARD: Scripted = Scripted::new("speculation-guard", "speculation_guard.summary");

/// `silent-agent-nudge`.
pub static SILENT_AGENT_NUDGE: Scripted = Scripted::new("silent-agent-nudge", "silent_nudge.summary");

/// `task-guard`.
pub static TASK_GUARD: Scripted = Scripted::new("task-guard", "task_guard.summary");

/// `tasklist-guard`.
pub static TASKLIST_GUARD: Scripted = Scripted::new("tasklist-guard", "tasklist_guard.summary");

/// `sibling-sweep` (Stop, SubagentStop; engine-only).
pub static SIBLING_SWEEP: Scripted = Scripted::new("sibling-sweep", "sibling_sweep.summary");

/// `handover-hygiene` (SessionStart; engine-only): the handover brief tree's advisory. The same script serves the
/// `handovers` command and the `handovers` scheduled job.
pub static HANDOVER_HYGIENE: Scripted = Scripted::new("handover-hygiene", "handovers.summary");

/// `merge-side-pick` (PreToolUse and PostToolUse on Bash; advisory only).
pub static MERGE_SIDE_PICK: Scripted = Scripted::new("merge-side-pick", "merge_side_pick.summary");

/// `scan-throttle` (PreToolUse on Bash; advisory only).
pub static SCAN_THROTTLE: Scripted = Scripted::new("scan-throttle", "scan_throttle.summary");

/// `merge-gate` (PreToolUse on Bash; opt-in).
pub static MERGE_GATE: Scripted = Scripted::new("merge-gate", "merge_gate.summary");

/// `task-lifecycle-log` (TaskCreated, TaskCompleted).
pub static TASK_LIFECYCLE_LOG: Scripted = Scripted::new("task-lifecycle-log", "task_lifecycle_log.summary");

/// `jev-weekly-scorecard` (SessionStart).
pub static JEV_WEEKLY_SCORECARD: Scripted = Scripted::new("jev-weekly-scorecard", "jev_weekly.summary");

/// `jev-review-reminder` (SessionStart).
pub static JEV_REVIEW_REMINDER: Scripted = Scripted::new("jev-review-reminder", "jev_review.summary");

/// `repair-on-reload` (SessionStart and UserPromptSubmit).
pub static REPAIR_ON_RELOAD: Scripted = Scripted::new("repair-on-reload", "repair_reload.summary");

/// `ask-guard` (PreToolUse on AskUserQuestion).
pub static ASK_GUARD: Scripted = Scripted::new("ask-guard", "ask_guard.summary");

/// `phase-tracker` (PreToolUse on Agent and Task; records the spawn for the statusline).
pub static PHASE_TRACKER: Scripted = Scripted::new("phase-tracker", "phase_tracker.summary");

/// `failure-root-cause-nudge` (PostToolUseFailure on Bash; advisory only).
pub static FAILURE_ROOT_CAUSE_NUDGE: Scripted = Scripted::new("failure-root-cause-nudge", "failure_nudge.summary");

/// `output-verify-guard` (PostToolUse on Bash; advisory only).
pub static OUTPUT_VERIFY_GUARD: Scripted = Scripted::new("output-verify-guard", "output_verify.summary");

/// `version-alert` (SessionStart).
pub static VERSION_ALERT: Scripted = Scripted::new("version-alert", "session.version_alert_summary");

/// `devswarm-version` (SessionStart).
pub static DEVSWARM_VERSION: Scripted = Scripted::new("devswarm-version", "session.devswarm_summary");

/// `claude-cli-version` (SessionStart).
pub static CLAUDE_CLI_VERSION: Scripted = Scripted::new("claude-cli-version", "session.claude_cli_summary");

/// `repo-self-drift` (SessionStart).
pub static REPO_SELF_DRIFT: Scripted = Scripted::new("repo-self-drift", "session.repo_self_drift_summary");

/// `defect-nudge` (SessionStart).
pub static DEFECT_NUDGE: Scripted = Scripted::new("defect-nudge", "session.defect_nudge_summary");

/// `progress-prune` (SessionStart).
pub static PROGRESS_PRUNE: Scripted = Scripted::new("progress-prune", "session.progress_prune_summary");

/// `emit-dedupe-reset` (SessionStart).
pub static EMIT_DEDUPE_RESET: Scripted = Scripted::new("emit-dedupe-reset", "emit_dedupe.summary");

/// `precompact-snapshot` (PreCompact).
pub static PRECOMPACT_SNAPSHOT: Scripted = Scripted::new("precompact-snapshot", "codex_handover.precompact_summary");

/// `limit-conserve-inject` (UserPromptSubmit).
pub static LIMIT_CONSERVE_INJECT: Scripted = Scripted::new("limit-conserve-inject", "ctxbudget.summary_limit_conserve");

/// `auto-handover` (UserPromptSubmit).
pub static AUTO_HANDOVER: Scripted = Scripted::new("auto-handover", "ctxbudget.summary_auto_handover");

/// `handover-resume` (SessionStart).
pub static HANDOVER_RESUME: Scripted = Scripted::new("handover-resume", "codex_handover.resume_summary");

/// `command` (PreToolUse on Bash): command-guard, the heavy-command gate, the Bash edit parity and the DevSwarm / stash guards. Its
/// script is also the shared command classifier (`classifyBashWork`) that coordinator-work-guard builds on.
pub static COMMAND_GUARD: Scripted = Scripted::new("command", "command.check_summary");

/// `coordinator-work-guard` (PreToolUse and PostToolUse on Bash): the main-thread work window; it classifies with the command script.
pub static COORDINATOR_WORK_GUARD: Scripted = Scripted::new("coordinator-work-guard", "coordinator_work.summary");
/// `procwatch-advisory` (SessionStart, UserPromptSubmit, PreToolUse; engine-only, advisory unless the owner opts into blocking at
/// critical disk space). A script failure defers to its no-op fallback, so a broken script is silence, never a block.
pub static PROCWATCH_ADVISORY: Scripted = Scripted::new("procwatch-advisory", "procwatch.summary");

/// `agent-reminders` (UserPromptSubmit, PostToolUse; engine-only): delivers the agent tracker's queued reminders.
pub static AGENT_REMINDERS: Scripted = Scripted::new("agent-reminders", "agent_tracker.summary");

/// `engine-role-guard` (PreToolUse on Bash; engine-only).
pub static ENGINE_ROLE_GUARD: Scripted = Scripted::new("engine-role-guard", "roles.summary_guard");

/// `engine-role-note` (SessionStart and SubagentStart; engine-only).
pub static ENGINE_ROLE_NOTE: Scripted = Scripted::new("engine-role-note", "roles.summary_note");
