#!/usr/bin/env node
// anti-hall :: dispatch-tier (PostToolUse TaskCreate|TaskUpdate, advisory, never blocks)
//
// Asks Jev (detached, zero latency) for a dispatch-tier recommendation —
// workspace / workflow / subagent — the moment a task's TEXT is created or
// changed, so task-tracker's next DISPATCH NOW line can annotate it from the
// cache. A TaskUpdate that does not touch subject/description is ignored (the
// text-hash cache would hit anyway). Owner-blocked tasks are never classified.
// See hooks/lib/dispatch-tier.js for modes, the repo override and metrics.
//
// Contract: stdin JSON { tool_name, tool_input, session_id, cwd, transcript_path }.
// No stdout. exit 0 always (fail-open).

'use strict';

const fs = require('fs');

function main() {
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return; }
  const name = payload && payload.tool_name;
  if (name !== 'TaskCreate' && name !== 'TaskUpdate') return;
  const inp = (payload && payload.tool_input) || {};
  const tier = require('./lib/dispatch-tier.js');
  const DD = require('./lib/dispatch-demand.js');

  let task = null;
  if (name === 'TaskCreate') {
    task = {
      content: inp.subject || inp.title || inp.content || inp.description || '',
      description: typeof inp.description === 'string' ? inp.description : '',
      blockedOn: inp.metadata && inp.metadata.blockedOn != null ? inp.metadata.blockedOn : inp.blockedOn,
    };
  } else {
    const hasText = (typeof inp.subject === 'string' && inp.subject) || typeof inp.description === 'string';
    const id = inp.taskId != null ? String(inp.taskId) : (inp.id != null ? String(inp.id) : null);
    if (!hasText || id == null) return;
    // Full text = the reconstructed task with this update's fields on top.
    let base = null;
    try {
      const lines = require('./lib/transcript-tail.js').readTail(payload.transcript_path);
      if (lines) {
        const state = require('./lib/task-state.js').reconstructTasks({ data: lines.join('\n'), truncated: false });
        // blockedOn/subject of a task created before the window (isOwnerBlocked below).
        require('./lib/task-subject-backfill.js').backfillSubjects(state.taskMap, payload.transcript_path, state);
        base = state.taskMap.get(id) || null;
      }
    } catch (_) { base = null; }
    task = Object.assign({ content: '', description: '' }, base || {});
    if (typeof inp.subject === 'string' && inp.subject) task.content = inp.subject;
    if (typeof inp.description === 'string') task.description = inp.description;
    if (inp.metadata && inp.metadata.blockedOn !== undefined) task.blockedOn = inp.metadata.blockedOn;
  }
  if (!task || !task.content || DD.isOwnerBlocked(task)) return;
  let home = null;
  try { home = require('../companion/lib/test-home-guard.js').resolveHome(); } catch (_) { return; }
  tier.request(task, { home, sessionId: payload.session_id, cwd: payload.cwd, transcriptPath: payload.transcript_path });
}

// No process.exit(): askDetached's stdin write to the detached worker must be
// allowed to flush; the unref()'d child never holds this process open.
try { main(); } catch (_) { /* fail-open */ }
process.exitCode = 0;
