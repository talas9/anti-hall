#!/usr/bin/env node
// anti-hall :: inbox-read-guard (PreToolUse Read — CLAUDE-ONLY, ALL contexts)
//
// WHAT IT DOES
//   Blocks a direct Read-tool read of a RAW DevSwarm inbox/store surface
//   (~/.anti-hall/devswarm/inbox/**, the store db + its sidecars, the store
//   journal NDJSON). Those must only ever be read through the wrapper
//   (devswarm.js inbox read/pull), never opened raw. Closes the Read-tool bypass
//   that command-guard (Bash-verb-only) structurally cannot see.
//
// ACCURATE HARM MODEL (do NOT say "it drains the queue"): the inbox is
//   APPEND-ONLY NDJSON — a raw read does NOT drain it. The harm is (1) CURSOR
//   DESYNC (the durable consumed-cursor is bypassed -> messages re-processed or
//   skipped) and (2) a STORE-LAYERING VIOLATION (devswarm-store.js: "hooks never
//   open the DB"; hooks/agents read the derived projections via the wrapper).
//
// ALL CONTEXTS (parent + child, coordinator + subagent): unlike edit-guard, this
//   has NO coordinator gate. The sanctioned consumers (devswarm-child-turn.js,
//   devswarm-parent-inbox.js, devswarm.js) read the inbox/store via Node `fs`,
//   NOT the Read tool, so they are exempt BY CONSTRUCTION — this only ever fires
//   on a model-issued Read-tool call, which should always go through the wrapper.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input: { file_path }, cwd }
//   stdout : JSON { decision: "block", reason: "..." } | nothing
//   exit 2 : to block (decision field); exit 0: allow
//   Fail-open on ANY error (exit 0). Dormant unless DevSwarm is active.

'use strict';

const fs = require('fs');
const os = require('os');

function buildReason(kind) {
  const bm = require('./lib/block-message.js');
  const override = 'set DISABLE_ANTIHALL_DEVSWARM=1 to disable this guard entirely';
  if (kind === 'deny-store') {
    return bm.blockMessage({
      guard: 'devswarm-store-read',
      what: 'reading the raw DevSwarm store (SQLite db, sidecars, journal NDJSON) directly is blocked.',
      why: 'The store is the write/derive layer; a raw read risks a partial view and a layering violation.',
      instead: '`devswarm.js inbox read <id>` (or `devswarm.js inbox pull <id>` first to import).',
      override,
    });
  }
  return bm.blockMessage({
    guard: 'devswarm-inbox-read',
    what: 'reading the raw DevSwarm inbox file directly is blocked.',
    why: 'It does not drain the queue, but bypasses the durable cursor, so messages get re-processed or skipped.',
    instead: '`devswarm.js inbox pull <id>` then `devswarm.js inbox read <id>`.',
    override,
  });
}

function main() {
  // Settings switch devswarm.inboxReadGuard (0.108.4): off -> no-op. Fail-open: any error runs the hook.
  try { if (!require('./lib/settings.js').enabled('devswarm', 'inboxReadGuard')) return; } catch (_) { /* run */ }
  // Read stdin first (fail-open on any read error).
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }

  // Escape hatch: honor an explicit, user-consented skip. Reuse the existing
  // DESTRUCTIVE skip name so `{all}` cannot silence it — only an explicit
  // `devswarm-read-guard` skip (like git-guard) does.
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('devswarm-read-guard')) process.exit(0);

  // Dormant unless the DevSwarm supervisor is active for THIS session/environment.
  let devswarmActive = false;
  try {
    devswarmActive = require('./lib/devswarm-detect.js').isDevswarmActive(process.env);
  } catch (_) {
    devswarmActive = false; // fail-open: dormant
  }
  if (!devswarmActive) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  // Read tool only — anything else passes through untouched.
  if (!payload || payload.tool_name !== 'Read') process.exit(0);

  const toolInput = (payload && payload.tool_input) || {};
  const filePath = toolInput.file_path || '';
  const cwd = (payload && payload.cwd) || '';

  let verdict = 'allow';
  try {
    verdict = require('./lib/devswarm-inbox-paths.js')
      .classifyDevswarmPath(filePath, os.homedir(), cwd);
  } catch (_) {
    verdict = 'allow'; // fail-open on any classifier error
  }
  if (verdict !== 'deny-inbox' && verdict !== 'deny-store') process.exit(0);

  const reason = buildReason(verdict);
  // fs.writeSync(1,…) not process.stdout.write per CLAUDE.md: on macOS node 18/20 a
  // synchronous exit right after process.stdout.write can race the async pipe flush
  // and truncate the JSON; writeSync is atomic. NEVER echoes the path (injection
  // hygiene — the reason is a fixed closed-vocabulary string).
  fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(2);
}

try {
  main();
} catch (_) {
  // Fail-open: never block a turn due to a hook bug.
}
process.exit(0);
