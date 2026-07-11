#!/usr/bin/env node
// anti-hall :: limit-conservation mode injector (UserPromptSubmit)
//
// When usage limits are high (per limit-conserve.js), injects a CONCISE
// directive into the turn context that routes expensive work to Codex and
// cheaper Claude models, keeping the main agent free. When limits are fine,
// emits an empty additionalContext (zero per-turn overhead).
//
// Contract (Claude Code UserPromptSubmit hook):
//   stdin  : JSON { session_id, prompt, cwd, transcript_path, ... }
//   stdout : JSON { hookSpecificOutput.additionalContext }
//   exit 0 : always — never wedge a turn
//
// Escape hatch: honored via skip-guard.js isSkipped('limit-conserve').
// Fail-open: any error → empty context, exit 0.
// stdout: fs.writeSync(1, ...) — synchronous, avoids async flush races on
// macOS Node 18/20 (mirrors task-tracker.js / verify-first.js pattern).

'use strict';

const fs = require('fs');
const { isConserving } = require('./limit-conserve.js');
const { isSkipped } = require('./skip-guard.js');

const DOWNSHIFT_DIRECTIVE =
  'MAIN-MODEL DOWNSHIFT: if the main agent is on the flagship model ' +
  '(Claude Opus or Codex gpt-5.6-sol), switch it to the cheaper 1M-context variant ' +
  'to preserve the flagship weekly bucket — ' +
  'Claude → Sonnet 5 (1M context), Codex → gpt-5.6-terra (1M context). ' +
  'NEVER downshift to a sub-1M model (e.g. gpt-5.4-mini has only 400k context). ' +
  'Keep the flagship for delegated hard-reasoning subagents and on-demand escalation. ' +
  'The agent cannot self-switch models (/model is a user action) — ' +
  'SURFACE this recommendation to the user; ' +
  'under an orchestration layer that can set the model (OMC/OMX), route main accordingly.';

function buildDirective(state) {
  const resetsClause = state.resetsAt
    ? ' Defer non-urgent heavy work until reset at ' + state.resetsAt + '.'
    : ' Defer non-urgent heavy work until the next reset.';
  return (
    'LIMIT CONSERVATION ACTIVE (' + state.reason + '): ' +
    'route execution to Codex (codex:codex-rescue — separate limit) and cheap Claude ' +
    '(Sonnet draws on a SEPARATE weekly bucket; Haiku for trivial). ' +
    'Keep the MAIN agent on Claude; send hard reasoning to subagents. ' +
    'Codex has its OWN limit — if it’s unavailable/rate-limited degrade to Sonnet, ' +
    'never retry-loop (backoff).' +
    resetsClause +
    ' ' + DOWNSHIFT_DIRECTIVE
  );
}

function main() {
  // stdin read — only for completeness (payload currently unused; skip-guard
  // needs no fields from it, and isConserving reads env + fs directly).
  try { fs.readFileSync(0, 'utf8'); } catch (_) { /* ignore */ }

  let text = '';

  try {
    if (!isSkipped('limit-conserve')) {
      const state = isConserving();
      if (state.active) {
        text = buildDirective(state);
      }
    }
  } catch (_) {
    // fail-open: text stays ''
  }

  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  };
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // fail-open: if we never wrote, Claude Code ignores missing stdout
}
process.exit(0);
