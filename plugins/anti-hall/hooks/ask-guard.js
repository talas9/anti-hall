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
// Independent of that mode, guards.questionAgentsNote (default on) adds one
// advisory line when agent-scan proves one or more background agents are in flight
// (they may act on an option before the answer arrives). Silent when the count is
// unknown or zero; never blocks; works with noBlockingQuestions off.
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

const ADVISE_TEXT = require('./lib/block-message.js').message({
  kind: 'tip',
  guard: 'ask-guard',
  what: 'do not hold work on a question.',
  instead: "take the recommended option, say which you took, and continue; list anything destructive or irreversible as a non-blocking 'needs your OK' line.",
});
const BLOCK_TEXT = require('./lib/block-message.js').blockMessage({
  guard: 'ask-guard',
  what: 'AskUserQuestion blocked by guards.noBlockingQuestions.',
  why: 'Work should not wait on a question.',
  instead: "decide the recommended option yourself, state it in your reply, and continue; list anything destructive or irreversible as a non-blocking 'needs your OK' line.",
  allowed: 'a question about a destructive or irreversible action, with the question header starting DESTRUCTIVE: (or CREDENTIAL: for a secret only the user can supply).',
});
const CHILD_TEXT = '\nChild workspace: send the question to your parent with `devswarm.js send --to-primary --question "..."` instead of asking the user directly.';

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

// agentsNote(payload) -> one advisory line, or '' when no agent is provably in
// flight. Silent on null (unknown: unreadable transcript, or a window too short to
// prove "none") and on an empty list. Fail-open to ''.
const NOTE_MAX_LISTED = 5;
const NOTE_DESC_MAX = 60;
function agentsNote(payload) {
  try {
    if (!require('./lib/settings.js').enabled('guards', 'questionAgentsNote')) return '';
    const tp = payload && payload.transcript_path;
    if (!tp || typeof tp !== 'string') return '';
    const agents = require('./lib/agent-scan.js').runningAgentsOrNull(tp);
    if (!Array.isArray(agents) || agents.length === 0) return '';
    const names = agents.slice(0, NOTE_MAX_LISTED).map((a) => {
      const d = String((a && a.description) || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, NOTE_DESC_MAX);
      return d || 'unnamed agent';
    });
    const more = agents.length > NOTE_MAX_LISTED ? ', +' + (agents.length - NOTE_MAX_LISTED) + ' more' : '';
    return agents.length + ' background agent' + (agents.length === 1 ? ' is' : 's are') + ' still in flight (' + names.join('; ') + more
      + '). They may act on one of these options before the answer arrives: pause them (SendMessage) or tell them to wait for the decision.';
  } catch (_) { return ''; }
}

function main() {
  let mode = 'off';
  try { mode = String(require('./lib/settings.js').get('guards', 'noBlockingQuestions') || 'off'); } catch (_) { mode = 'off'; }
  if (mode !== 'advise' && mode !== 'block') mode = 'off';
  let noteOn = true;
  try { noteOn = require('./lib/settings.js').enabled('guards', 'questionAgentsNote'); } catch (_) { noteOn = true; }
  if (mode === 'off' && !noteOn) return;

  try { if (require('./skip-guard.js').isSkipped('ask-guard')) return; } catch (_) { /* stay active */ }

  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  if (payload.tool_name !== 'AskUserQuestion') return;

  let child = false;
  try { child = require('./lib/devswarm-role.js').isChildWorkspace(process.env); } catch (_) { child = false; }
  const suffix = child ? CHILD_TEXT : '';

  if (mode === 'block') {
    const marker = markerOf(payload.tool_input);
    if (!marker) { emit({ decision: 'block', reason: BLOCK_TEXT + suffix }, 2); return; }
    logMarker(marker);
  }
  const parts = [];
  if (mode === 'advise') parts.push(ADVISE_TEXT + suffix);
  const note = agentsNote(payload);
  if (note) parts.push(note);
  if (parts.length) emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: parts.join('\n') } }, 0);
}

try { main(); } catch (_) { /* fail-open */ }
process.exit(0);
