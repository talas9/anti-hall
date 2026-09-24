#!/usr/bin/env node
// anti-hall :: auto-handover pause nag (Stop)
//
// Complements hooks/auto-handover.js's fire + milestone nags with a
// NATURAL-PAUSE reminder: once the fire directive has already gone out this
// session and context is still over threshold, this fires (at most once per
// `nagQuietMin` minutes, default 15) when the turn is ending at a genuinely
// quiet point — no pending/in-progress TodoWrite tasks and no subagent
// spawned in the last 2 minutes (phase-tracker.js's own activity window). A
// turn with open work or a running swarm is never interrupted for this.
//
// MECHANISM: Stop hooks have no non-blocking "informational" output in this
// harness — every other advisory Stop hook (task-guard.js, tasklist-guard.js)
// surfaces text via `{"decision":"block","reason":...}`, and that is reused
// here for one short line. `stop_hook_active` (hooks/lib/stop-policy.js) is
// checked first so a block is never immediately re-triggered by its own
// answer — the agent relays the one-liner, stops again, and that second Stop
// call is let through unconditionally.
//
// Never fires: for a subagent/sidechain Stop, when auto-handover is
// disabled/never fired this session, when nag=false, when still under
// threshold (also re-arms the shared latch, mirroring auto-handover.js),
// within the quiet window of the last nag (of EITHER kind), with open tasks,
// or with a recent subagent spawn.
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { session_id, transcript_path, cwd, stop_hook_active, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to block, or nothing.
//   exit 0 : ALWAYS — fail-open on any error.
//
// Escape hatch: honored via skip-guard.js isSkipped('auto-handover').
// Pure Node built-ins only.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isSubagentByPayload } = require('./coordinator-detect.js');
const { isSkipped } = require('./skip-guard.js');
const { stopHookActive } = require('./lib/stop-policy.js');
const { getContextPct } = require('./lib/context-pct.js');
const { resolveEffective } = require('./lib/auto-handover-config.js');
const { sessionTag, readLatch, writeLatch } = require('./lib/auto-handover-state.js');

const BLOAT_SENTENCE =
  'As context grows the model gets less efficient and more prone to hallucination, ' +
  'so compacting/clearing keeps answers accurate, not just under the limit.';

const SPAWN_LOG = path.join(os.homedir(), '.anti-hall', 'agent-spawns.log');
const SPAWN_ACTIVITY_MS = 2 * 60 * 1000; // matches statusline/phase-bar.js's ACTIVITY_MS

function buildPauseNag(pct) {
  return (
    'Good stopping point: context is still ~' + Math.round(pct) + '% and a handover is already saved. ' +
    BLOAT_SENTENCE + ' Mention /compact or /clear to the user now.'
  );
}

// hasRecentSpawn(tag, now) -> true if agent-spawns.log has an entry for this
// session tag within the last SPAWN_ACTIVITY_MS. Mirrors statusline/
// phase-bar.js's recentSpawns() exactly (same log, same window, same "<ms>
// <tag>" line shape) so "no running background agents" agrees with what the
// statusline would show as active. Fail-open: unreadable log -> false (never
// blocks the nag on a missing/corrupt log).
function hasRecentSpawn(tag, now) {
  if (!tag) return false;
  try {
    return fs.readFileSync(SPAWN_LOG, 'utf8').trim().split(/\r?\n/).some((line) => {
      if (!line) return false;
      const sp = line.indexOf(' ');
      if (sp < 0) return false; // legacy untagged line — not attributable, ignore
      const ms = parseInt(line.slice(0, sp), 10);
      const lineTag = line.slice(sp + 1);
      return lineTag === tag && Number.isFinite(ms) && (now - ms) <= SPAWN_ACTIVITY_MS;
    });
  } catch (_) {
    return false;
  }
}

// readTailLines — same small tail-read shape as hooks/lib/context-pct.js
// (kept local/duplicated rather than shared: this file only needs the LAST
// TodoWrite call, a different scan than context-pct's usage lookup).
function readTailLines(transcriptPath, bytes) {
  let fd = null;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= 0) return null;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fd = fs.openSync(transcriptPath, 'r');
    const got = fs.readSync(fd, buf, 0, n, size - n);
    let lines = buf.toString('utf8', 0, got).split('\n');
    if (size > n) lines = lines.slice(1);
    return lines;
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* best-effort */ } }
  }
}

// hasOpenTasks(transcriptPath) -> true | false | null. Finds the LAST
// main-thread TodoWrite tool_use call in the tail (widened once) and checks
// whether any of its todos are pending/in_progress. null (no TodoWrite call
// found at all) is treated by the caller the SAME as false: a session that
// never tracked tasks with TodoWrite has nothing recorded as open — the safe
// direction here is to still allow the pause nag (many short sessions never
// call TodoWrite at all; treating "untracked" as "assume open forever" would
// mean this nag never fires for them).
function hasOpenTasks(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  for (const bytes of [256 * 1024, 4 * 1024 * 1024]) {
    const lines = readTailLines(transcriptPath, bytes);
    if (!lines) return null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || line.indexOf('TodoWrite') === -1) continue;
      let e;
      try { e = JSON.parse(line); } catch (_) { continue; }
      if (!e || e.type !== 'assistant' || e.isSidechain === true) continue;
      const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
      for (let j = content.length - 1; j >= 0; j--) {
        const item = content[j];
        if (!item || item.type !== 'tool_use' || item.name !== 'TodoWrite') continue;
        const todos = item.input && Array.isArray(item.input.todos) ? item.input.todos : [];
        return todos.some((t) => t && (t.status === 'pending' || t.status === 'in_progress'));
      }
    }
  }
  return null; // no TodoWrite call found in either tail -> unknown
}

function main() {
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { payload = null; }

  try {
    if (!payload || typeof payload !== 'object') { emit(); return; }
    if (isSubagentByPayload(payload)) { emit(); return; }
    if (stopHookActive(payload)) { emit(); return; }
    if (isSkipped('auto-handover')) { emit(); return; }

    const home = os.homedir();
    const env = process.env;
    const settings = resolveEffective({ home, env });
    if (!settings.enabled || !settings.nag) { emit(); return; }

    const tag = sessionTag(payload);
    if (!tag) { emit(); return; }

    const latch = readLatch(home, tag);
    if (latch.fired !== true) { emit(); return; } // nothing fired yet this arm

    const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
    const result = getContextPct(transcriptPath, env, { home, sessionId: payload.session_id });
    if (!result || !Number.isFinite(result.pct)) { emit(); return; }

    const now = Date.now();
    if (result.pct < settings.pct) {
      writeLatch(home, tag, { fired: false }); // dropped back below -> re-arm
      emit();
      return;
    }

    const lastNagAt = Number.isFinite(latch.lastNagAt) ? latch.lastNagAt : 0;
    if ((now - lastNagAt) < settings.nagQuietMin * 60 * 1000) { emit(); return; }

    const open = hasOpenTasks(transcriptPath);
    if (open === true) { emit(); return; } // KNOWN open work -> don't interrupt it

    if (hasRecentSpawn(tag, now)) { emit(); return; } // a subagent is still running

    writeLatch(home, tag, Object.assign({}, latch, { lastNagAt: now }));
    emit(buildPauseNag(result.pct));
  } catch (_) {
    emit(); // fail-open
  }
}

function emit(reason) {
  try {
    if (reason) {
      fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n');
    }
    // else: emit nothing -> Stop proceeds normally.
  } catch (_) {
    /* fail-open */
  }
}

try {
  main();
} catch (_) {
  /* fail-open */
}
process.exit(0);
