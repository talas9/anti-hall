#!/usr/bin/env node
// anti-hall :: failure-root-cause-nudge (PostToolUseFailure, matcher Bash, ADVISORY ONLY)
//
// Fires when a Bash tool call fails (non-zero exit / tool-level error). The
// event is the "command exited non-zero" signal; the filter below only removes
// the cases where non-zero is not a failure (expected predicate exits, harness
// refusals) and repeats within one turn. Injects a
// SHORT reminder pointing at the /anti-hall:root-cause skill: trace the
// actual cause before patching, rather than guessing a fix from the symptom.
//
// KEPT DELIBERATELY SHORT: OMC (oh-my-claudecode) already injects its own
// verify-first/root-cause reminders in this harness. Stacking a second long
// block on every single failed command is noise, not help — this hook adds
// one short line, not a restatement of the full root-cause playbook.
//
// CONFIG (env):
//   ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE=off  -> disable (fail-open exit 0)
//   ANTIHALL_FAILURE_NUDGE_FILTER=off      -> nudge on EVERY non-zero exit again
//     (default on: skip harness refusals + expected exit-1 predicates, and show
//     the reminder once per turn — see lib/expected-failure.js, lib/turn-gate.js)
// Escape hatch: ~/.anti-hall/skip.json {"failure-root-cause-nudge": <future-ts>}.
//
// FAIL-OPEN: any error -> exit 0, no block, no stderr noise, ever.
//
// Contract (Claude Code PostToolUseFailure hook):
//   stdin  : JSON { hook_event_name: 'PostToolUseFailure', tool_name,
//                    tool_input?, session_id, cwd, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } }
//   exit 0 : always. This hook never emits `decision:"block"` — annotate
//            only, per the Phase-1 build constraint (never block).

'use strict';

const fs = require('fs');
// v0.108.0 unified settings (env > ~/.anti-hall/settings.json > default);
// fail-open to `undefined` (never the value that would disable a guard).
function settingsGet(section, key) {
  try { return require('./lib/settings.js').get(section, key); } catch (_) { return undefined; }
}

const MAX_CMD_LEN = 80;

function truncateCommand(cmd) {
  if (typeof cmd !== 'string') return '';
  const oneLine = cmd.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_CMD_LEN) return oneLine;
  return oneLine.slice(0, MAX_CMD_LEN) + '…';
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    raw = '';
  }

  if (settingsGet('guards', 'failureRootCauseNudge') === false) {
    process.exit(0);
  }

  // Escape hatch: shared user-consented skip. Outer main() try/catch fails
  // OPEN on any skip-guard error, matching codex-nudge/speculation-guard.
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('failure-root-cause-nudge')) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }
  if (!payload || payload.tool_name !== 'Bash') process.exit(0);

  // v0.201 noise filter (guards.failureNudgeFilter, default on): stay silent when
  // the "failure" is not one — a harness refusal (command never ran), or an
  // expected exit 1 from a predicate (grep no-match, test, diff, ...) — and show
  // the reminder at most once per turn (the text never changes between calls).
  const errorText = typeof payload.error === 'string' ? payload.error : '';
  if (settingsGet('guards', 'failureNudgeFilter') !== false) {
    try {
      const ef = require('./lib/expected-failure.js');
      const cmdText = payload.tool_input && typeof payload.tool_input.command === 'string' ? payload.tool_input.command : '';
      if (payload.is_interrupt === true) process.exit(0);
      if (ef.isHarnessRefusal(errorText) || ef.isExpectedNonzero(cmdText, errorText)) process.exit(0);
      if (!require('./lib/turn-gate.js').firstThisTurn({
        sessionId: payload.session_id,
        agentId: typeof payload.agent_id === 'string' ? payload.agent_id : '',
        transcriptPath: payload.transcript_path,
        key: 'failure-root-cause-nudge',
      })) process.exit(0);
    } catch (_) { /* fail-open: fall through and nudge */ }
  }

  const cmd = payload.tool_input && typeof payload.tool_input.command === 'string'
    ? payload.tool_input.command
    : '';
  const shown = truncateCommand(cmd);
  const cmdPart = shown ? ' (`' + shown + '`)' : '';

  const reason = require('./lib/block-message.js').message({
    kind: 'tip',
    guard: 'root-cause',
    what: 'this command failed' + cmdPart + '.',
    instead: 'before retrying or patching, trace WHY it failed (see /anti-hall:root-cause) rather than guessing a fix from the symptom.',
  });

  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext: reason,
    },
  };

  // fs.writeSync(1,...) not process.stdout.write: on macOS node 18/20 async
  // pipe flush can race process.exit(0) and truncate the JSON; writeSync is
  // atomic (same reasoning as verify-first-subagent.js / command-guard.js).
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: never block or wedge a PostToolUseFailure turn.
}
process.exit(0);
