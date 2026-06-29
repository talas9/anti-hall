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

// Subagent-specific disciplines footer: the always-apply trio (root-cause,
// anti-sycophancy, scope-fidelity) WITHOUT the orchestration delegation rules.
// Includes a clear note that the worker should do the work itself.
const SUBAGENT_DISCIPLINES = [
  'DISCIPLINES (SUBAGENT — orchestration-delegation rules omitted; you are a worker, not an orchestrator):',
  'ALWAYS APPLY:',
  "  - root-cause: the IRON LAW + RATIONALIZATION TABLE + POSITIVE RULES above. No claim without evidence; no fix without a proven root cause; instrument, don't guess.",
  '  - anti-sycophancy: do not agree just to agree. If the user or a premise is wrong, challenge it with evidence. User agreement is not correctness (Positive Rule 9).',
  '  - scope-fidelity: the SCOPE & FIDELITY block above. Simplest sufficient solution; intent over letter; confirm before expanding scope; match rigor to blast radius; finish asked work and drop nothing.',
  '  - subagent role: DO the work yourself; do NOT re-delegate unless your task explicitly says to orchestrate. Shallow and direct beats deep chains. Return a TIGHT summary — findings only, no transcript, no re-pasted file bodies.',
  'INVOKE WHEN IT MATCHES (conditional skills, not every turn):',
  '  - /anti-hall:root-cause - full debugging playbook when investigating a specific bug/failure.',
  '  - /anti-hall:deadly-loop - HARDEN risky changes BEFORE merge: cross-file/cross-PR coordination, security-sensitive changes, schema/production-data touches, shell scripts, CI/workflow YAML, LLM-prompt work.',
].join('\n');

const SUBAGENT_TEXT = [...CORE_LINES, SUBAGENT_DISCIPLINES].join('\n');

function main() {
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

  const out = {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: SUBAGENT_TEXT,
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
