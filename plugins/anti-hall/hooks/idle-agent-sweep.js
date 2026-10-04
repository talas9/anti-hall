#!/usr/bin/env node
// anti-hall :: idle-agent-sweep (UserPromptSubmit, ADVISORY ONLY, never stops anything)
//
// Field case (2026-10-04): a coordinator left 34 named teammates that had sent
// their final report sitting idle for up to ~1.5 h, because nothing reminded it
// to TaskStop them; each kept its process and context alive. This hook lists the
// agents this session's transcript shows FINISHED but never stopped (Claude:
// teammates; Codex: multi_agent_v1 agents never closed; rules in
// lib/idle-agents.js) and gives the exact call to end them.
//
// WHEN: once per user prompt (UserPromptSubmit is once per turn; a queued burst
// collapses to one copy via lib/emit-dedupe.js). A <task-notification> turn is
// not a human turn and is skipped. Fires only when >= guards.idleAgentSweepCount
// finished agents are idle, or any one has been idle >= guards.idleAgentSweepMin
// minutes.
//
// Settings: guards.idleAgentSweep (default true; ANTIHALL_IDLE_AGENT_SWEEP=off),
// guards.idleAgentSweepCount (default 3), guards.idleAgentSweepMin (default 15).
// Escape hatch: ~/.anti-hall/skip.json {"idle-agent-sweep": <future-ts>}.
//
// Contract (UserPromptSubmit): stdin JSON { session_id, prompt, transcript_path, cwd, ... };
// stdout { hookSpecificOutput: { hookEventName, additionalContext } } or nothing; exit 0 always.

'use strict';
require('./lib/judge-child-exit');

const fs = require('fs');

// Same widened window agent-scan uses to prove a running-agent count: a
// teammate's spawn record must be in the window for its reports to count.
const SCAN_BYTES = 12 * 1024 * 1024;

// Injectable clock: only under ANTIHALL_TEST_ISOLATION=1 (tests and replays).
function now() {
  const e = process.env;
  if (e.ANTIHALL_TEST_ISOLATION === '1' && e.ANTIHALL_TEST_NOW_MS) {
    const n = Number(e.ANTIHALL_TEST_NOW_MS);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

function setting(key, dflt) {
  try {
    const v = require('./lib/settings.js').get('guards', key, dflt);
    return Number.isFinite(v) && v >= 1 ? v : dflt;
  } catch (_) { return dflt; }
}

// advisory(payload, nowMs) -> string ('' = nothing to say)
function advisory(payload, nowMs) {
  const tp = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (!tp) return '';
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trimStart() : '';
  if (prompt.startsWith('<task-notification>')) return '';
  let codex = false;
  try { codex = require('./lib/auto-handover-text.js').detectPlatform(payload) === 'codex'; } catch (_) { codex = false; }
  const lines = require('./lib/transcript-tail.js').readTail(tp, SCAN_BYTES);
  const IA = require('./lib/idle-agents.js');
  const res = IA.finishedAgents(tp, lines, { codex, nowMs });
  if (!res || !IA.shouldFire(res.agents, nowMs, { count: setting('idleAgentSweepCount', 3), minutes: setting('idleAgentSweepMin', 15) })) return '';
  return IA.message(res, nowMs);
}

function main() {
  try { if (!require('./lib/settings.js').enabled('guards', 'idleAgentSweep')) return; } catch (_) { /* run */ }
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return; }
  if (!payload || typeof payload !== 'object') return;
  try { if (require('./skip-guard.js').isSkipped('idle-agent-sweep')) return; } catch (_) { /* proceed */ }

  const text = advisory(payload, now());
  if (!text) return;
  let emit = true;
  try {
    emit = require('./lib/emit-dedupe.js').shouldEmit({
      home: require('../companion/lib/test-home-guard.js').resolveHome(), sessionId: payload.session_id,
      transcriptPath: payload.transcript_path, key: 'idle-agent-sweep', content: text,
      normalize: (t) => t.replace(/\(\d+m\)/g, ''),
    });
  } catch (_) { emit = true; }
  if (!emit) return;
  fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }) + '\n');
}

if (require.main === module) {
  try { main(); } catch (_) { /* fail-open */ }
  process.exit(0);
}

module.exports = { advisory };
