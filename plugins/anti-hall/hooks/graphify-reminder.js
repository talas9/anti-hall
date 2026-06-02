#!/usr/bin/env node
// anti-hall :: graphify update reminder (Stop hook)
//
// Fires on Stop. IF significant code edits happened this session AND a graphify
// graph exists, it surfaces a gentle one-time reminder to run '/graphify
// --obsidian' so the knowledge graph stays in sync with the code.
//
// DELIVERY MECHANISM (verified against the official Claude Code hooks docs):
//   A Stop hook does NOT inject `additionalContext`. Per the official docs, only
//   UserPromptSubmit, UserPromptExpansion, and SessionStart add stdout/
//   additionalContext to the model's context on exit 0; for every other event
//   (including Stop) stdout is written to the debug log only. A Stop hook's ONLY
//   model-reaching output channel is the top-level decision control:
//   {"decision":"block","reason":"..."} . So to make the reminder actually reach
//   the model we surface it ONCE as a soft block (decision:block) with the
//   reminder as the reason - exactly the channel task-guard.js uses. Earlier
//   versions wrote the reminder to stderr (exit 0) or as flat/nested
//   additionalContext on stdout (exit 0); BOTH are silent no-ops on Stop. (The
//   same "keep the graph updated" instruction also lives in the SessionStart
//   primer in graphify-session.js, which IS a context-injection event, so the
//   guidance is delivered on session start regardless.)
//
// Design constraints:
//   - GENTLE: blocks at most ONCE per session (a single nudge, never a loop),
//     capped + deduped via os.tmpdir state like task-guard. After the one nudge
//     it stays quiet so the user can stop.
//   - CHEAP: it does NOT run graphify (that can be expensive). Just a nudge.
//   - SAFE no-op: if no graph exists or no significant edits happened, do nothing.
//   - NO STATE IN THE PROJECT TREE (F-07): loop-state lives under os.tmpdir(),
//     never written into the user's repo, so it can't pollute the tree or show as
//     dirty git status.
//   - Pure Node built-ins only (OS-agnostic): JSON.parse for the payload, no
//     grep/sed/jq/python3.
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { session_id, transcript_path, cwd, ... }
//   stdout : JSON {"decision":"block","reason":"<reminder>"} to surface the nudge
//            ONCE, or nothing. exit 0 either way (the block is signalled by the
//            JSON decision field, not by the exit code).
//   exit 0 : always. Fail-open on any error.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function gitToplevel(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const top = (out || '').split(/\r?\n/)[0].trim();
    return top || null;
  } catch (_) {
    return null;
  }
}

function safeIsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function hasGraph(root) {
  if (!root) return false;
  return safeIsDir(path.join(root, 'graphify-out')) ||
         safeIsDir(path.join(root, '.planning', 'graphs'));
}

// Count Edit/Write/MultiEdit/NotebookEdit tool_use entries in the transcript.
// Read the file fully then split into lines (JSONL) so we never miss an early
// entry. Walk each parsed entry for tool_use blocks by name.
function countEdits(transcriptPath) {
  let count = 0;
  let data;
  try {
    data = fs.readFileSync(transcriptPath, 'utf8');
  } catch (_) {
    return 0;
  }
  const lines = data.split(/\r?\n/);
  const EDIT_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }
    count += countToolUses(entry, EDIT_NAMES);
  }
  return count;
}

function countToolUses(node, names) {
  if (!node || typeof node !== 'object') return 0;
  let c = 0;
  if (node.type === 'tool_use' && typeof node.name === 'string' && names.has(node.name)) {
    c += 1;
  }
  for (const key of ['content', 'message', 'messages', 'tool_uses', 'parts']) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) c += countToolUses(item, names);
    } else if (val && typeof val === 'object') {
      c += countToolUses(val, names);
    }
  }
  return c;
}

function main() {
  let payload = {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    payload = JSON.parse(raw);
  } catch (_) {
    payload = {};
  }

  const cwd = (payload && typeof payload.cwd === 'string' && payload.cwd) ? payload.cwd : process.cwd();

  // 1. Is there a graphify graph for this project?
  const roots = [cwd];
  const top = gitToplevel(cwd);
  if (top && top !== cwd) roots.push(top);

  let projectRoot = null;
  for (const r of roots) {
    if (hasGraph(r)) { projectRoot = r; break; }
  }
  if (!projectRoot) process.exit(0); // no graph -> nothing to remind about

  // 2. Did significant code edits happen this session?
  const transcriptPath = (payload && typeof payload.transcript_path === 'string')
    ? payload.transcript_path : '';
  if (!transcriptPath) process.exit(0);

  let editCount = 0;
  try { editCount = countEdits(transcriptPath); } catch (_) { editCount = 0; }
  if (editCount < 2) process.exit(0); // not significant -> stay quiet

  // 3. Surface the reminder ONCE via the only Stop channel that reaches the model:
  //    a soft block (decision:block) carrying the reminder as the reason. We cap
  //    it to a single nudge per session via os.tmpdir state (F-07: never written
  //    into the user's project tree), so a Stop hook can never loop the user.
  //    additionalContext is NOT a Stop output field (see header), so we do not
  //    emit it here.
  const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
    crypto.createHash('sha1').update(String(transcriptPath)).digest('hex').slice(0, 16);
  const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
  const stateDir = path.join(os.homedir(), '.anti-hall');
  const stateFile = path.join(stateDir, 'graphify-reminder-' + safeSession);

  // Already nudged this session? Stay quiet (single, non-looping reminder).
  try {
    if (fs.existsSync(stateFile)) process.exit(0);
  } catch (_) { /* fall through */ }

  // Record that we are nudging BEFORE we emit, so a failure to persist makes us
  // fail-open (no nudge) rather than risk re-blocking on the next Stop.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, String(Date.now()), 'utf8');
  } catch (_) {
    process.exit(0); // can't persist -> do not block (avoid any loop risk)
  }

  try {
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason:
          'graphify: significant edits this session and a knowledge graph is ' +
          'present. Consider running `/graphify --obsidian` to keep the graph ' +
          'current before stopping (one-time reminder; stop again to dismiss).',
      }) + '\n'
    );
  } catch (_) { /* ignore */ }
}

try {
  main();
} catch (_) {
  // Fail-open.
}
process.exit(0);
