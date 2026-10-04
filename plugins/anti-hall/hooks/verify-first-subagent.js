#!/usr/bin/env node
// anti-hall :: verify-first protocol for spawned subagents (SubagentStart).
//
// Injects the IRON LAW + RATIONALIZATION TABLE + POSITIVE RULES + SCOPE &
// FIDELITY core into every spawned subagent at the moment it starts. This is
// the primacy slot for subagents — equivalent to SessionStart for the main
// session, but scoped to worker context.
//
// WHAT IS DELIBERATELY OMITTED:
//   The ORCHESTRATION DISCIPLINE block (rules A-N: delegate everything, drain
//   the task list, spin parallel agents, synthesize/never relay, etc.) is
//   NOT injected here. Those rules are for the main orchestrator thread. If
//   re-injected into a subagent, they instruct the worker to re-delegate its
//   own work, creating deep general-purpose→general-purpose nesting chains —
//   exactly the anti-pattern rule M warns against. A subagent is a WORKER: it
//   does the work itself.
//
// Contract:
//   stdin  : JSON { hook_event_name: 'SubagentStart', session_id, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } }
//   exit 0 : always (fail-open — never block a subagent from starting).
//
// SubagentStart confirmation: listed in KB-claude-codex.md §1.1 under
// "Permission/team" events, sourced from the official hooks ref and plugins ref.

'use strict';

const fs = require('fs');
const { CORE_LINES } = require('./verify-first-core');

// Subagent disciplines footer, teammate note and child-workspace note live in verify-first-core.js
// (moved verbatim; the output is byte-identical).
const { SUBAGENT_DISCIPLINES, TEAMMATE_REPORTING_NOTE, CHILD_WORKSPACE_MAILBOX_NOTE } = require('./verify-first-core');

const SUBAGENT_TEXT_BASE = [...CORE_LINES, SUBAGENT_DISCIPLINES, TEAMMATE_REPORTING_NOTE].join('\n');

function main() {
  // Settings switch context.verifyFirstSubagent (0.108.4): off -> no-op. Fail-open: any error runs the hook.
  try { if (!require('./lib/settings.js').enabled('context', 'verifyFirstSubagent')) return; } catch (_) { /* run */ }
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    raw = '';
  }

  // Honor skip-guard. Fail-open if skip-guard.js cannot be loaded.
  try {
    const { isSkipped } = require('./skip-guard.js');
    if (isSkipped('verify-first-subagent')) process.exit(0);
  } catch (_) { /* skip-guard unavailable — proceed */ }

  // Parse the event name for the echo-back field. Default to SubagentStart.
  let event = 'SubagentStart';
  try {
    const payload = JSON.parse(raw);
    const name = payload && typeof payload.hook_event_name === 'string'
      ? payload.hook_event_name
      : '';
    if (name === 'SubagentStart') event = 'SubagentStart';
  } catch (_) {
    event = 'SubagentStart';
  }

  // Fail-open: any throw (env unreadable, module missing) -> not a child
  // workspace -> base text only, never a crash.
  let isChild = false;
  try {
    isChild = require('./lib/devswarm-role.js').isChildWorkspace(process.env);
  } catch (_) {
    isChild = false;
  }
  const subagentText = isChild
    ? [SUBAGENT_TEXT_BASE, CHILD_WORKSPACE_MAILBOX_NOTE].join('\n')
    : SUBAGENT_TEXT_BASE;

  const out = {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: subagentText,
    },
  };

  // Synchronous write (same reasoning as verify-first-full.js): avoids the
  // macOS node 18/20 async pipe truncation that occurs with process.stdout.write
  // when the payload exceeds the pipe buffer and process.exit(0) races the flush.
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: never block a subagent from starting.
}
process.exit(0);
