#!/usr/bin/env node
// anti-hall :: devswarm-child-role (SessionStart)
//
// If this session is a DevSwarm CHILD workspace sub-orchestrator (liveness
// supervisor active AND DEVSWARM_SOURCE_BRANCH non-empty), inject a short
// self-report reminder: an idle child should proactively message its parent
// rather than sit unnoticed off the parent's task list.
//
// Safe no-op for Primary / non-DevSwarm sessions: no output, exit 0 — byte-
// identical to today. Pure Node built-ins only.
//
// Contract (Claude Code SessionStart hook):
//   stdin  : JSON { hook_event_name, session_id, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } } | nothing
//   exit 0 : always (fail-open on ANY error).

'use strict';

const fs = require('fs');
const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');

function main() {
  // Read stdin only to stay consistent with the SessionStart contract; the
  // payload itself carries nothing this hook needs (role/liveness come from env).
  try { fs.readFileSync(0, 'utf8'); } catch (_) { /* empty/absent stdin is fine */ }

  if (!isDevswarmActive(process.env)) return;
  if (!isChildWorkspace(process.env)) return;

  const additionalContext =
    'DEVSWARM CHILD WORKSPACE: if you have been idle with no active task for a ' +
    'while, proactively run `hivecontrol workspace message-parent` to report ' +
    '"idle — reassign me a task or archive me," so the parent orchestrator\'s ' +
    'task list stays honest instead of you sitting idle unnoticed.';

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
