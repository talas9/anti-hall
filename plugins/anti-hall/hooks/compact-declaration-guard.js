#!/usr/bin/env node
// anti-hall :: compact-declaration-guard (PreToolUse)
//
// Field defect (0.115.x): the model declared "SAFE TO COMPACT" and then
// started new work — a background Agent, a Bash merge — in the SAME turn.
// skills/handover/SKILL.md says the declaration is the LAST act of the turn;
// this makes that mechanical.
//
// BLOCKS when the CURRENT turn's assistant text (since the last real user
// message — hooks/lib/compact-advice.js readTurn()) holds an active
// compact recommendation (activeDeclaration(): SAFE TO COMPACT / good point to
// /compact / "/compact" offered as an instruction, not followed by a
// retraction) and the tool call is new work:
//   Agent / Task spawns, Write / Edit / MultiEdit / NotebookEdit, and
//   state-changing Bash (hooks/lib/work-detect.js BASH_WORK_RE on the
//   quote-neutralized command, plus git push / git tag / gh pr merge).
// Read-only tools are not matched by the hooks.json matcher at all, and a
// read-only Bash command passes.
//
// NO DEADLOCK: a later real user message starts a new turn (resets), and an
// explicit retraction line from the assistant — "RETRACT SAFE TO COMPACT" —
// clears it within the turn. Injected <task-notification>s do NOT reset: a
// background result arriving after SAFE is exactly the "kept working" case.
//
// Contract (PreToolUse): matches sibling PreToolUse guards (command-guard.js,
// edit-guard.js) — stdout {"decision":"block","reason":…} then exit 2 to
// block; nothing + exit 0 to allow.
// Switch: guards.compactDeclarationGuard. Skip: skip-guard 'compact-declaration-guard'.
// FAIL-OPEN everywhere. Pure Node built-ins.

'use strict';

const fs = require('fs');

const WORK_TOOLS = new Set(['Agent', 'Task', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const EXTRA_BASH_WORK_RE = /\bgit\s+(?:push|tag)\b|\bgh\s+pr\s+(?:merge|create)\b/i;

function isNewWork(payload) {
  const name = String(payload.tool_name || '');
  if (WORK_TOOLS.has(name)) return true;
  const cmd = payload.tool_input && typeof payload.tool_input.command === 'string' ? payload.tool_input.command : null;
  if (cmd === null) return false;
  const { BASH_WORK_RE, neutralizeQuotedContents } = require('./lib/work-detect.js');
  const n = neutralizeQuotedContents(cmd);
  return BASH_WORK_RE.test(n) || EXTRA_BASH_WORK_RE.test(n);
}

function main() {
  const settings = require('./lib/settings.js');
  if (!settings.enabled('guards', 'compactDeclarationGuard', { home: require('../companion/lib/test-home-guard.js').resolveHome(), env: process.env })) return;

  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return; }
  if (!payload || typeof payload !== 'object') return;

  const { isSubagentByPayload } = require('./coordinator-detect.js');
  const { isSkipped } = require('./skip-guard.js');
  if (isSubagentByPayload(payload) || isSkipped('compact-declaration-guard')) return;
  if (!isNewWork(payload)) return;

  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
  if (!transcriptPath) return;
  const { readTail } = require('./lib/transcript-tail.js');
  const lines = readTail(transcriptPath);
  if (!lines) return;

  const advice = require('./lib/compact-advice.js');
  const decl = advice.activeDeclaration(advice.readTurn(lines).turnText);
  if (!decl) return;

  fs.writeSync(1, JSON.stringify({
    decision: 'block',
    reason: 'anti-hall compact-declaration-guard: you declared SAFE TO COMPACT this turn ("' + decl.phrase +
      '") — stop, or retract the declaration and refresh the handover. The declaration must be the last act of the turn; ' +
      'new work (' + (payload.tool_name || 'this tool') + ') after it makes the handover stale. To continue working, first write a line ' +
      '"RETRACT SAFE TO COMPACT — <why>", then refresh the handover before declaring again. Read-only tools stay allowed.',
  }) + '\n');
  process.exit(2);
}

try { main(); } catch (_) { /* fail-open */ }
process.exit(0);
