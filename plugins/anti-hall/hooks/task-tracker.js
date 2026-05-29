#!/usr/bin/env node
// anti-hall :: task-list discipline injector (UserPromptSubmit)
//
// Fires on every UserPromptSubmit. Injects a short, high-salience directive
// reminding the model to capture every user request as a task before acting,
// keep statuses current, delegate heavy work to background subagents, and
// report progress - so no request is silently dropped.
//
// Contract (Claude Code UserPromptSubmit hook):
//   stdin  : JSON { session_id, prompt, cwd, transcript_path, ... }  (ignored)
//   stdout : JSON { hookSpecificOutput.additionalContext } added to the turn
//   exit 0 : always - allow prompt, inject context
//
// Content is STATIC by design - it is the discipline directive, distinct from
// the per-turn VARYING nudge (verify-first.js). JSON via JSON.stringify so it is
// always well-formed. No external deps. Fail-open on any error.

'use strict';

const MESSAGE =
  'TASK-LIST DISCIPLINE: capture EVERY user request as a task (TaskCreate) ' +
  'before starting work, so no request is lost. Assign each task a priority ' +
  '(metadata.priority: P0/P1/P2) and maintain the list sorted ' +
  'highest-priority-first so the most important work is always on top; work ' +
  'tasks in that order. Keep statuses current: in_progress when starting, ' +
  'completed when done, deferred if explicitly deprioritized. Keep the MAIN ' +
  'thread non-blocking - delegate heavy/long work to background subagents and ' +
  'continue. Report progress to the user. Do not finish a turn with ' +
  'silently-dropped requests.';

try {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: MESSAGE,
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
} catch (_) {
  // Fail-open.
}
process.exit(0);
