#!/usr/bin/env node
// anti-hall :: devswarm-child-role (SessionStart)
//
// v0.58 "mesh-only messaging": injects the FULL DEVSWARM COMMUNICATION OVERRIDE
// directive for BOTH DevSwarm roles (Primary AND child workspace sub-
// orchestrator) at SessionStart — the primacy slot, and the only lever against
// DevSwarm's own `--system-prompt-file` REPLACE at spawn (PLAN.md "Locked
// design"). It tells the session anti-hall's shared mesh store is the ONLY
// messaging channel for DevSwarm coordination (native hivecontrol SEND commands
// — `workspace message-child`/`message-parent` — are now guard-blocked,
// command-guard.js), gives the mesh CLI verbs to report/direct-message/check in,
// and states the Tier-0 RESTING-state posture (keep polling the mesh instead of
// idling silently). A CHILD additionally gets a short idle-self-report nudge.
// Scope = COMMUNICATION ONLY — this never touches or replaces DevSwarm's own
// task-brief system prompt.
//
// v0.59 "self-wake": both roles additionally get the MAILBOX WAKE directive —
// create a CronCreate job (the only primitive that fires while the REPL is IDLE)
// that drains this workspace's mailbox. See lib/devswarm-wake.js for the full
// rationale, the agent-correctness rule, and the interval knob.
//
// Safe no-op for non-DevSwarm sessions: no output, exit 0. Pure Node built-ins.
//
// Contract (Claude Code SessionStart hook):
//   stdin  : JSON { hook_event_name, session_id, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } } | nothing
//   exit 0 : always (fail-open on ANY error).

'use strict';

const fs = require('fs');
const path = require('path');
const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');

// CLI — the ABSOLUTE path to anti-hall's DevSwarm CLI wrapper, resolved ONCE
// from this hook's own on-disk location (never a relative "scripts/devswarm.js"
// string — see P1 fix below: a DevSwarm child's cwd is its PROJECT WORKTREE,
// not the plugin root, so a relative path in emitted text is unrunnable there).
const CLI = path.join(__dirname, '..', 'scripts', 'devswarm.js');

// OVERRIDE_CORE — the full COMMUNICATION OVERRIDE directive (PLAN.md "OVERRIDE +
// WAKE-TIER0"), identical for both roles. Deliberately avoids the literal
// strings `message-child`/`message-parent` (uses the `message-*` wildcard form
// instead) so this text itself never re-introduces the blocked native verbs
// into emitted hook output (the hook-text-sweep acceptance criterion).
const OVERRIDE_CORE =
  'DEVSWARM COMMUNICATION OVERRIDE: anti-hall\'s shared mesh store is this workspace\'s ' +
  'ONLY messaging channel for DevSwarm coordination — native hivecontrol send commands ' +
  '(`workspace message-*`) are BLOCKED. Report status: `node ' + CLI + ' ' +
  'heartbeat <id> --summary "<text>"`. Direct-message: `node ' + CLI + ' send ' +
  '--to-primary --message "<text>"` (or `--to <meshId>`). Check in: `node ' + CLI + ' ' +
  'roster`, `mesh read`, `inbox read-primary <id>`. RESTING state = ' +
  'keep polling the mesh — do not idle silently. Scope: COMMUNICATION ONLY; this never ' +
  'changes your assigned task.';

// CHILD_IDLE_LINE — appended for a child only: the self-report nudge this hook
// carried pre-v0.58, now via the mesh `heartbeat --summary` verb instead of the
// blocked native `hivecontrol workspace message-parent`.
const CHILD_IDLE_LINE =
  ' If you have been idle with no active task for a while, proactively run `node ' +
  CLI + ' heartbeat <id> --summary "idle — reassign me a task or archive ' +
  'me"` so the parent orchestrator\'s task list stays honest instead of you sitting ' +
  'idle unnoticed.';

// MAILBOX WAKE (v0.59): appended for BOTH roles (both have mailboxes). A workspace
// that finishes its turn goes IDLE and nothing wakes it, so a message landing after
// that point is never read. The fix is a directive — the agent itself CronList-checks
// and (re-)creates a Claude `CronCreate` job (the one primitive that fires while the
// REPL is idle; recurring tasks self-delete after 7 days, so the check is a RENEWAL,
// not a one-shot create); a hook cannot call a tool. Role-correct by construction:
// only an agent hivecontrol names as `claude` is told about CronCreate; Codex/other
// gets the honest "no idle-wake primitive here, drain every turn" line; an unknown
// agent gets nothing. Text + cron knob live in lib/devswarm-wake.js (shared with
// devswarm-child-gate.js's bounded Stop re-verify, so the two can never drift).
//
// LAZY + GUARDED require (the idiom edit-guard.js / devswarm-child-gate.js already
// use for their DevSwarm libs): a top-level require sits OUTSIDE main()'s try/catch,
// so a lib that is missing from a package or throws on load would CRASH this
// SessionStart hook instead of failing open. Degrade to the pre-wake output (the
// COMMUNICATION OVERRIDE, no wake directive) — never crash, never block.
function wakeLine(env, isChild) {
  try {
    return require('./lib/devswarm-wake.js').wakeDirective(env, isChild, CLI);
  } catch (_) {
    return ''; // fail-open: pre-v0.59 behavior
  }
}

function buildAdditionalContext(isChild, env) {
  return OVERRIDE_CORE + (isChild ? CHILD_IDLE_LINE : '') + wakeLine(env, isChild);
}

function main() {
  // Read stdin only to stay consistent with the SessionStart contract; the
  // payload itself carries nothing this hook needs (role/liveness come from env).
  try { fs.readFileSync(0, 'utf8'); } catch (_) { /* empty/absent stdin is fine */ }

  if (!isDevswarmActive(process.env)) return;

  const additionalContext = buildAdditionalContext(isChildWorkspace(process.env), process.env);

  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
  // Synchronous write to fd 1 (macOS node 18/20 flush-safety convention — see
  // graphify-session.js / verify-first-full.js for the full rationale).
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open.
}
process.exit(0);
