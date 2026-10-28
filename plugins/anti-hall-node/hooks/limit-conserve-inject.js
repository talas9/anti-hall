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
require('./lib/judge-child-exit');

const fs = require('fs');
const { isConserving } = require('./limit-conserve.js');
const { isSkipped } = require('./skip-guard.js');

const DOWNSHIFT_DIRECTIVE =
  'Main-model downshift: if the main agent is on the flagship model ' +
  '(Claude Opus or Codex frontier category), switch it to the cheaper 1M-context variant ' +
  'to use less of the shared Claude pool (a cheaper model draws it down more slowly) — ' +
  'Claude → Sonnet (1M context), Codex → the workhorse category\'s 1M-context model ' +
  '(resolve the slug from the live catalog; never pin one). ' +
  'NEVER downshift to a smaller-context model (e.g. a fast-category model may have well ' +
  'under 1M context) — check the catalog\'s context window first. ' +
  'Keep the flagship for delegated hard-reasoning subagents and on-demand escalation. ' +
  'The agent cannot self-switch models (/model is a user action) — ' +
  'SURFACE this recommendation to the user; ' +
  'under an orchestration layer that can set the model (OMC/OMX), route main accordingly.';

// The usage API reports the reset with ms jitter (…:59.957Z vs …:00.295Z on
// consecutive turns), which changed the directive text every turn and defeated
// emit-dedupe. Render at nearest-minute precision (display AND dedupe key).
function minuteRounded(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return String(iso);
  return new Date(Math.round(t / 60000) * 60000).toISOString().replace(':00.000Z', 'Z');
}

function buildDirective(state) {
  const resetsClause = state.resetsAt
    ? ' Defer non-urgent heavy work until reset at ' + minuteRounded(state.resetsAt) + '.'
    : ' Defer non-urgent heavy work until the next reset.';
  return require('./lib/block-message.js').message({
    kind: 'warn',
    guard: 'limit-conserve',
    what: 'limit conservation is active (' + state.reason + ').',
    why: 'Usage is near a plan limit.',
    instead: 'route execution to Codex (codex:codex-rescue, separate limit) and cheap Claude (Sonnet, or Haiku for trivial work, uses less of the shared Claude pool; no Claude model is a separate bucket); keep the MAIN agent on Claude and send hard reasoning to subagents; if Codex is unavailable or rate-limited degrade to Sonnet, never retry-loop (backoff).' + resetsClause + ' ' + DOWNSHIFT_DIRECTIVE,
  });
}

function main() {
  // stdin read — skip-guard needs no fields from it and isConserving reads
  // env + fs directly, but session_id/transcript_path feed emit-dedupe below
  // (the LIMIT CONSERVATION + downshift block is identical turn-to-turn while
  // the reason/resetsAt don't change, so it was re-sent on every single turn).
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { payload = null; }

  let text = '';

  try {
    if (!isSkipped('limit-conserve')) {
      const state = isConserving();
      if (state.active) {
        const built = buildDirective(state);
        const sessionId = (payload && typeof payload.session_id === 'string') ? payload.session_id : null;
        const transcriptPath = (payload && typeof payload.transcript_path === 'string') ? payload.transcript_path : null;
        let emit = true;
        try {
          emit = require('./lib/emit-dedupe.js').shouldEmit({
            sessionId, transcriptPath, key: 'limit-conserve', content: built, keepaliveTurns: 10,
          });
        } catch (_) { emit = true; }
        if (emit) text = built;
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
