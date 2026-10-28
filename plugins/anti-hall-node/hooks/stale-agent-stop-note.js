#!/usr/bin/env node
// anti-hall :: stale-agent-stop-note (PreToolUse TaskStop, ADVISORY ONLY)
//
// Field case (2026-10-02): a coordinator sent a message to a named teammate,
// then received that teammate's EARLIER end-of-turn report (written to the
// transcript only when the coordinator's own turn yielded), read it as the
// agent's current state, and later ran TaskStop on it. The message had in fact
// restarted the agent, which had done an hour of work by then.
//
// When TaskStop names an agent that this session's transcript shows was sent a
// message (teammate inbox) or resumed (background agent) AFTER its last report,
// with no report since, this hook adds one line saying so. It never blocks,
// never returns a permission decision, and says nothing when the state is
// unknown (fail-open). State comes from lib/agent-scan.js (structured
// transcript records only).
//
// Setting: guards.staleAgentStopNote (default true); ANTIHALL_STALE_AGENT_STOP_NOTE=off disables.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name: "TaskStop", tool_input: { task_id }, transcript_path, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } } | nothing
//   exit 0 always.

'use strict';

const fs = require('fs');

// Same reach as silent-agent-nudge: the send can sit well before the shared
// 1.5MB tail when the turns in between carry large attachments.
const SCAN_BYTES = 64 * 1024 * 1024;

function hhmm(ms) {
  return new Date(ms).toISOString().slice(11, 16) + ' UTC';
}
function oneLine(s, max) {
  let o = String(s).replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (o.length > max) o = o.slice(0, max).trimEnd() + '…';
  return o;
}

// note(scan, taskId, nowMs) -> string | null
function note(scan, taskId, nowMs) {
  if (!scan || typeof taskId !== 'string' || !taskId) return null;
  let name = null;
  let pm = null;
  for (const [n, p] of scan.pendingMessages || []) {
    if (n === taskId || (p.agentId && p.agentId === taskId)) { name = n; pm = p; break; }
  }
  if (pm) {
    const last = Number.isFinite(pm.lastIdleMs) ? ' (' + hhmm(pm.lastIdleMs) + ')' : '';
    const seen = pm.lastSeenMs > pm.sentAtMs
      ? ' Its own transcript was last written ' + Math.max(0, Math.round((nowMs - pm.lastSeenMs) / 60000)) + ' min ago.'
      : '';
    return require('./lib/block-message.js').message({
      kind: 'warn',
      guard: 'stale-stop',
      what: '"' + oneLine(name, 60) + '" was sent a message at ' + hhmm(pm.sentAtMs) + ', after its last report' + last + ', and has not reported since.',
      why: 'It may be working on that message.' + seen,
      instead: 'advisory only; the stop is not blocked.',
    });
  }
  const rec = scan.launched.get(taskId);
  if (rec && !rec.teammate && !scan.terminal.has(taskId) && Number.isFinite(rec.resumedAtMs) && rec.resumedAtMs > 0) {
    return require('./lib/block-message.js').message({
      kind: 'warn',
      guard: 'stale-stop',
      what: '"' + oneLine(taskId, 60) + '" was resumed at ' + hhmm(rec.resumedAtMs) + ', after its last report, and has not reported since.',
      why: 'It may be working.',
      instead: 'advisory only; the stop is not blocked.',
    });
  }
  return null;
}

function main() {
  try { if (!require('./lib/settings.js').enabled('guards', 'staleAgentStopNote')) return; } catch (_) { /* run */ }

  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return; }
  if (!payload || typeof payload !== 'object' || payload.tool_name !== 'TaskStop') return;
  const taskId = payload.tool_input && payload.tool_input.task_id;
  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (typeof taskId !== 'string' || !taskId || !transcriptPath) return;

  const { readTail } = require('./lib/transcript-tail.js');
  const { scanTranscript } = require('./lib/agent-scan.js');
  const lines = readTail(transcriptPath, SCAN_BYTES);
  if (!lines) return;
  const nowMs = Date.now();
  // The TaskStop being judged may already be in the transcript, unanswered.
  const text = note(scanTranscript(transcriptPath, lines, { nowMs, ignoreUnansweredStops: true }), taskId, nowMs);
  if (!text) return;
  // fs.writeSync(1, …): a synchronous exit can race process.stdout's pipe flush on macOS.
  fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }) + '\n');
}

if (require.main === module) {
  try { main(); } catch (_) { /* fail-open */ }
  process.exit(0);
}

module.exports = { note };
