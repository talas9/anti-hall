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
// clears it within the turn. Only an explicit SAFE declaration counts (not the
// pause nag's mandated "GOOD POINT TO /compact" footer or /compact command),
// and Write/Edit of .anti-hall/handovers/** is exempt (refreshing the handover). Injected <task-notification>s do NOT reset: a
// background result arriving after SAFE is exactly the "kept working" case.
//
// Contract (PreToolUse): evaluate(payload, env) returns {exitCode, stdout, stderr};
// a block is stdout {"decision":"block","reason":…} + exit 2, an allow is nothing +
// exit 0 (the CLI wrapper at the bottom writes the streams and exits).
// Switch: guards.compactDeclarationGuard. Skip: skip-guard 'compact-declaration-guard'.
// FAIL-OPEN everywhere. Pure Node built-ins.

'use strict';

const path = require('path');
const io = require('./lib/guard-io.js');

const WORK_TOOLS = new Set(['Agent', 'Task', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const EXTRA_BASH_WORK_RE = /\bgit\s+(?:push|tag)\b|\bgh\s+pr\s+(?:merge|create)\b/i;

// Writing/editing the handover itself is the very thing the block message tells
// the agent to do — never new work. Resolved + segment-anchored so `..`
// traversal, `.anti-hall/handovers-x/`, and the bare dir itself stay blocked.
const HANDOVER_FILE_RE = /(?:^|\/)\.anti-hall\/handovers\/[^/][^]*$/;
function isHandoverEdit(payload) {
  const ti = payload.tool_input || {};
  const fp = typeof ti.file_path === 'string' ? ti.file_path : (typeof ti.notebook_path === 'string' ? ti.notebook_path : null);
  if (!fp) return false;
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  return HANDOVER_FILE_RE.test(path.resolve(cwd, fp).split(path.sep).join('/'));
}

function isNewWork(payload) {
  const name = String(payload.tool_name || '');
  if (WORK_TOOLS.has(name)) return !isHandoverEdit(payload);
  const cmd = payload.tool_input && typeof payload.tool_input.command === 'string' ? payload.tool_input.command : null;
  if (cmd === null) return false;
  const { BASH_WORK_RE, neutralizeQuotedContents } = require('./lib/work-detect.js');
  const n = neutralizeQuotedContents(cmd);
  return BASH_WORK_RE.test(n) || EXTRA_BASH_WORK_RE.test(n);
}

function evaluate(payload, env, opts) {
  try { return decide(payload, env || process.env); } catch (_) { return io.decision(0); } // fail-open
}

function decide(payload, env) {
  const settings = require('./lib/settings.js');
  if (!settings.enabled('guards', 'compactDeclarationGuard', { home: require('../companion/lib/test-home-guard.js').resolveHome(), env })) return io.decision(0);

  if (!payload || typeof payload !== 'object') return io.decision(0);

  const { isSubagentByPayload } = require('./coordinator-detect.js');
  const { isSkipped } = require('./skip-guard.js');
  if (isSubagentByPayload(payload) || isSkipped('compact-declaration-guard')) return io.decision(0);
  if (!isNewWork(payload)) return io.decision(0);

  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
  if (!transcriptPath) return io.decision(0);
  const { readTail } = require('./lib/transcript-tail.js');
  const lines = readTail(transcriptPath);
  if (!lines) return io.decision(0);

  const advice = require('./lib/compact-advice.js');
  const decl = advice.activeDeclaration(advice.readTurn(lines).turnText, { declarationsOnly: true });
  if (!decl) return io.decision(0);

  return io.blockDecision(require('./lib/block-message.js').blockMessage({
    guard: 'compact-declaration-guard',
    what: 'you declared SAFE TO COMPACT this turn ("' + decl.phrase + '") and then started new work (' + (payload.tool_name || 'this tool') + ').',
    why: 'The declaration must be the last act of the turn; new work after it makes the handover stale.',
    instead: 'stop, or retract: write a line "RETRACT SAFE TO COMPACT: <why>", then refresh the handover before declaring again.',
    allowed: 'read-only tools.',
  }));
}

module.exports = { evaluate };

if (require.main === module) io.runCli(evaluate);
