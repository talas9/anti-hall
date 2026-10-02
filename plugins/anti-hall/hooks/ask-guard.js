#!/usr/bin/env node
// anti-hall :: ask-guard (PreToolUse AskUserQuestion — OPTIONAL, default OFF)
//
// Owner rule: do not hold work on a question. Decide the recommended option,
// say which one was taken, and continue; only destructive or irreversible items
// stay undone, as non-blocking "needs your OK" lines. This guard makes that rule
// mechanical, opt-in, via the setting guards.noBlockingQuestions:
//   off    (default) -> no output.
//   advise -> allow the call, add one line of context (the standing rule).
//   block  -> block the call, unless the FIRST question starts with the literal
//             marker DESTRUCTIVE: or CREDENTIAL: (case-sensitive, after trimming),
//             in its `header` or at the start of its `question` text. The header
//             is limited to ~12 characters, so the question text is accepted too.
//             A marked call is allowed and one line is appended to
//             ~/.anti-hall/logs/ask-guard.ndjson.
// No other heuristic: the guard never infers what the user wants from the transcript.
//
// In a DevSwarm CHILD workspace the doctrine is child -> parent -> human, so
// block and advise add one sentence pointing at `devswarm.js send --to-primary
// --question ...`.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input: { questions: [{ question, header, options, multiSelect }] } }
//   block  : fs.writeSync(1, JSON { decision: "block", reason }) + exit 2
//   advise : fs.writeSync(1, JSON { hookSpecificOutput: { hookEventName, additionalContext } }) + exit 0
//   never emits a permission "allow" decision. Fail-open on ANY error (exit 0, no output).
//   Skip name: ask-guard.

'use strict';

const fs = require('fs');
const path = require('path');

const MARKER_RE = /^(DESTRUCTIVE|CREDENTIAL):/;

const ADVISE_TEXT = "Standing rule: do not hold work on a question. Take the recommended option, say which you took, and continue; list anything destructive or irreversible as a non-blocking 'needs your OK' line.";
const BLOCK_TEXT = "Blocked by guards.noBlockingQuestions: decide the recommended option yourself, state it in your reply, and continue. List anything destructive or irreversible as a non-blocking 'needs your OK' line. If this question really is about a destructive or irreversible action, re-issue it with the question header starting with DESTRUCTIVE: — or CREDENTIAL: if it needs a secret only the user can supply.";
const CHILD_TEXT = " You are a DevSwarm child workspace: send the question to your parent with `devswarm.js send --to-primary --question \"...\"` instead of asking the user directly.";

function emit(obj, code) {
  try { fs.writeSync(1, JSON.stringify(obj) + '\n'); } catch (_) {}
  process.exit(code);
}

// markerOf(toolInput) -> 'DESTRUCTIVE' | 'CREDENTIAL' | null, from the FIRST question only.
function markerOf(toolInput) {
  const qs = toolInput && toolInput.questions;
  const first = Array.isArray(qs) ? qs[0] : null;
  if (!first || typeof first !== 'object') return null;
  for (const field of [first.header, first.question]) {
    if (typeof field !== 'string') continue;
    const m = MARKER_RE.exec(field.trim());
    if (m) return m[1];
  }
  return null;
}

// Best-effort, fail-open append of one NDJSON line recording marker use.
function logMarker(marker) {
  try {
    const home = require('../companion/lib/test-home-guard.js').resolveHome(undefined, process.env);
    const dir = path.join(home, '.anti-hall', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'ask-guard.ndjson'),
      JSON.stringify({ ts: new Date().toISOString(), event: 'marker-allowed', marker }) + '\n');
  } catch (_) { /* fail-open */ }
}

function main() {
  let mode = 'off';
  try { mode = String(require('./lib/settings.js').get('guards', 'noBlockingQuestions') || 'off'); } catch (_) { mode = 'off'; }
  if (mode !== 'advise' && mode !== 'block') return;

  try { if (require('./skip-guard.js').isSkipped('ask-guard')) return; } catch (_) { /* stay active */ }

  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  if (payload.tool_name !== 'AskUserQuestion') return;

  let child = false;
  try { child = require('./lib/devswarm-role.js').isChildWorkspace(process.env); } catch (_) { child = false; }
  const suffix = child ? CHILD_TEXT : '';

  if (mode === 'advise') {
    emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ADVISE_TEXT + suffix } }, 0);
    return;
  }

  const marker = markerOf(payload.tool_input);
  if (marker) { logMarker(marker); return; }
  emit({ decision: 'block', reason: BLOCK_TEXT + suffix }, 2);
}

try { main(); } catch (_) { /* fail-open */ }
process.exit(0);
