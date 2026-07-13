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
// Safe no-op for non-DevSwarm sessions: no output, exit 0. Pure Node built-ins.
//
// Contract (Claude Code SessionStart hook):
//   stdin  : JSON { hook_event_name, session_id, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } } | nothing
//   exit 0 : always (fail-open on ANY error).

'use strict';

const fs = require('fs');
const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');

// OVERRIDE_CORE — the full COMMUNICATION OVERRIDE directive (PLAN.md "OVERRIDE +
// WAKE-TIER0"), identical for both roles. Deliberately avoids the literal
// strings `message-child`/`message-parent` (uses the `message-*` wildcard form
// instead) so this text itself never re-introduces the blocked native verbs
// into emitted hook output (the hook-text-sweep acceptance criterion).
const OVERRIDE_CORE =
  'DEVSWARM COMMUNICATION OVERRIDE: anti-hall\'s shared mesh store is this workspace\'s ' +
  'ONLY messaging channel for DevSwarm coordination — native hivecontrol send commands ' +
  '(`workspace message-*`) are BLOCKED. Report status: `node scripts/devswarm.js ' +
  'heartbeat <id> --summary "<text>"`. Direct-message: `node scripts/devswarm.js send ' +
  '--to-primary --message "<text>"` (or `--to <meshId>`). Check in: `node ' +
  'scripts/devswarm.js roster`, `mesh read`, `inbox read-primary <id>`. RESTING state = ' +
  'keep polling the mesh — do not idle silently. Scope: COMMUNICATION ONLY; this never ' +
  'changes your assigned task.';

// CHILD_IDLE_LINE — appended for a child only: the self-report nudge this hook
// carried pre-v0.58, now via the mesh `heartbeat --summary` verb instead of the
// blocked native `hivecontrol workspace message-parent`.
const CHILD_IDLE_LINE =
  ' If you have been idle with no active task for a while, proactively run `node ' +
  'scripts/devswarm.js heartbeat <id> --summary "idle — reassign me a task or archive ' +
  'me"` so the parent orchestrator\'s task list stays honest instead of you sitting ' +
  'idle unnoticed.';

function buildAdditionalContext(isChild) {
  return OVERRIDE_CORE + (isChild ? CHILD_IDLE_LINE : '');
}

function main() {
  // Read stdin only to stay consistent with the SessionStart contract; the
  // payload itself carries nothing this hook needs (role/liveness come from env).
  try { fs.readFileSync(0, 'utf8'); } catch (_) { /* empty/absent stdin is fine */ }

  if (!isDevswarmActive(process.env)) return;

  const additionalContext = buildAdditionalContext(isChildWorkspace(process.env));

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
