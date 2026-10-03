#!/usr/bin/env node
// anti-hall :: auto-handover pause nag + Stop-side fire (Stop)
//
// STOP-SIDE FIRE: when the fire directive has NOT gone out yet this arm and
// the main agent is over threshold at a Stop, this hook delivers the same
// fire directive hooks/auto-handover.js would (once — shared latch), so a
// long autonomous turn (ralph/ultrawork-style loops, queued work) that never
// passes UserPromptSubmit still gets told to write its handover before
// auto-compact. Guarded by stop_hook_active like the nag below.
//
// Complements hooks/auto-handover.js's fire + milestone nags with a
// NATURAL-PAUSE reminder: once the fire directive has already gone out this
// session and context is still over threshold, this fires when context has
// risen >= `nagStepPct` points past the last nag's baseline, or otherwise at
// most once per `nagQuietMin` minutes (default 15) — never repeating the
// identical pct within one step — when the turn is ending at a genuinely
// quiet point — no pending/in-progress task work (TodoWrite AND anti-hall's
// own TaskCreate/TaskUpdate lifecycle — see hasOpenTasks()) and no subagent
// spawn recorded in the last 2 minutes (phase-tracker.js's own activity
// window; this is a RECENCY heuristic, not a live liveness check — a swarm
// that spawned longer ago but is still genuinely running is not detected
// here, so "never interrupted" only holds for spawns within that window).
//
// MECHANISM: Stop hooks have no non-blocking "informational" output in this
// harness — every other advisory Stop hook (task-guard.js, tasklist-guard.js)
// surfaces text via `{"decision":"block","reason":...}`, and that is reused
// here for one short line. `stop_hook_active` (hooks/lib/stop-policy.js) is
// checked first so a block is never immediately re-triggered by its own
// answer — the agent relays the one-liner, stops again, and that second Stop
// call is let through unconditionally.
//
// The NAG never fires: for a subagent/sidechain Stop, when auto-handover is
// disabled/never fired this session, when nag=false, when still under
// threshold (also re-arms the shared latch, mirroring auto-handover.js),
// within the quiet window of the last nag (of EITHER kind), with open tasks,
// or with a recent subagent spawn.
//
// I/O: reads the transcript tail ONCE (hooks/lib/transcript-tail.js, capped)
// and shares it between the context-pct lookup and hasOpenTasks() — this used
// to be two independent (up to 4MB-widened) reads on a single Stop call.
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
const { resolveEffective, overThreshold } = require('./lib/auto-handover-config.js');
const { sessionTag, readLatch, writeLatch } = require('./lib/auto-handover-state.js');
const { readTail } = require('./lib/transcript-tail.js');
const { buildFireDirective, buildPauseNag, buildDecisiveSuffix } = require('./lib/auto-handover-text.js');
const { sessionHandover } = require('./lib/auto-handover-gate.js');
const freshness = require('./lib/handover-freshness.js');

const SPAWN_LOG = path.join(os.homedir(), '.anti-hall', 'agent-spawns.log');
const SPAWN_ACTIVITY_MS = 2 * 60 * 1000; // matches statusline/phase-bar.js's ACTIVITY_MS

// hasRecentSpawn(tag, now) -> true if agent-spawns.log has an entry for this
// session tag within the last SPAWN_ACTIVITY_MS. Mirrors statusline/
// phase-bar.js's recentSpawns() exactly (same log, same window, same "<ms>
// <tag>" line shape) so "recent activity" agrees with what the statusline
// would show. This is a RECENCY window, not a live process check — it cannot
// see a subagent spawned longer than SPAWN_ACTIVITY_MS ago that is still
// genuinely running. Fail-open: unreadable log -> false (never blocks the
// nag on a missing/corrupt log).
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

// hasOpenTasks(lines) -> true | false | null. Scans the SHARED tail (see
// main()) FORWARD/chronologically — task state accumulates across multiple
// calls, unlike a single "last call wins" lookup — for:
//   - TodoWrite: replaces the whole tracked list (id/content/status)
//   - TaskCreate / TaskUpdate: anti-hall's own Task-tool lifecycle
//     (tasklist-guard.js:466-844 tracks the same three tool names for its
//     own open-task gate; that file exports NOTHING to require — it is a
//     standalone Stop-hook script, not a library — so this mirrors its field
//     conventions (input.status, input.taskId/id/task_id) rather than
//     importing them). KNOWN LIMITATION vs tasklist-guard.js's fuller parser:
//     a TaskUpdate that targets a task by its harness-assigned NUMERIC id
//     (only knowable from the TaskCreate tool_result, which this scan does
//     NOT follow) won't match the TaskCreate call's tool_use id key here, so
//     that update can be missed. Acceptable for an ADVISORY nag suppressor
//     (worst case: an occasional extra/missed nag), not acceptable for a hard
//     gate — this file only ever softly reminds, never blocks real work.
// null when NEITHER TodoWrite nor TaskCreate/TaskUpdate ever appeared in the
// visible tail (nothing tracked at all) -> caller still allows the nag (many
// short sessions never track tasks; "untracked" must not mean "assume open
// forever" or this nag would never fire for them).
function hasOpenTasks(lines) {
  if (!lines) return null;
  let sawAny = false;
  const taskMap = new Map(); // key -> status

  for (const line of lines) {
    if (!line) continue;
    if (line.indexOf('TodoWrite') === -1 && line.indexOf('TaskCreate') === -1 && line.indexOf('TaskUpdate') === -1) continue;
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (!e || e.type !== 'assistant' || e.isSidechain === true) continue;
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const item of content) {
      if (!item || item.type !== 'tool_use') continue;

      if (item.name === 'TodoWrite') {
        const todos = item.input && Array.isArray(item.input.todos) ? item.input.todos : [];
        taskMap.clear();
        sawAny = true;
        let i = 0;
        for (const t of todos) {
          const id = (t && (t.id || t.content)) || String(i++);
          taskMap.set('todo:' + id, (t && t.status) || 'pending');
        }
        continue;
      }

      if (item.name === 'TaskCreate') {
        sawAny = true;
        const inp = item.input || {};
        const toolUseId = item.id || '';
        if (toolUseId) taskMap.set('task:' + toolUseId, inp.status || 'pending');
        continue;
      }

      if (item.name === 'TaskUpdate') {
        sawAny = true;
        const inp = item.input || {};
        const id = inp.taskId != null ? String(inp.taskId)
          : inp.id != null ? String(inp.id)
          : inp.task_id != null ? String(inp.task_id) : null;
        if (id != null && inp.status) {
          const key = 'task:' + id; // see KNOWN LIMITATION above
          taskMap.set(key, inp.status);
        }
      }
    }
  }

  if (!sawAny) return null;
  for (const status of taskMap.values()) {
    if (status === 'pending' || status === 'in_progress') return true;
  }
  return false;
}

// relativeHandoverPath(payload, filePath) -> filePath relative to payload.cwd
// when possible (matches the '.anti-hall/handovers/...' style the fire
// directive already shows via expectedHandoverPath), else the raw filePath.
function relativeHandoverPath(payload, filePath) {
  const cwd = payload && typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
  if (!cwd || !filePath) return filePath;
  try {
    const rel = path.relative(cwd, filePath);
    return rel && !rel.startsWith('..') ? rel : filePath;
  } catch (_) {
    return filePath;
  }
}

// decisiveSuffixFor(payload, settings, lines) — the DECISIVE PROMPT
// (autoHandover.decisivePrompt, default on): '' when off or when this
// session has no handover file yet (nothing to be decisive ABOUT — the
// fire directive's own "write it, then urge /compact" wording already
// covers that case). Otherwise the good-point / stale-refresh line built
// from hooks/lib/handover-freshness.js, which judges "work after the
// handover" with tasklist-guard.js's own detector (hooks/lib/work-detect.js);
// an unknown freshness (no readable transcript) gets a neutral line.
function decisiveSuffixFor(payload, settings, lines) {
  if (!settings.decisivePrompt) return '';
  let h = null;
  try { h = sessionHandover(payload); } catch (_) { h = null; }
  if (!h) return '';
  const fresh = freshness.isFresh(lines, h.mtimeMs);
  const taskComplete = fresh === true ? freshness.isTaskCompleteFromFile(h.filePath) : false;
  return buildDecisiveSuffix(payload, relativeHandoverPath(payload, h.filePath), fresh, taskComplete);
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
    if (!settings.enabled) { emit(); return; }

    const tag = sessionTag(payload);
    if (!tag) { emit(); return; }

    const latch = readLatch(home, tag);
    const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
    const lines = transcriptPath ? readTail(transcriptPath) : null; // ONE shared read

    if (latch.fired !== true) {
      // STOP-SIDE FIRE (once per arm): a long autonomous turn can cross the
      // threshold and reach auto-compact without ever passing
      // UserPromptSubmit, where hooks/auto-handover.js fires. Same latch, so
      // whichever hook sees the crossing first fires and the other stays
      // quiet. Never for a pct crossing against an unknown (guessed) window
      // — the UserPromptSubmit hook's soft advisory covers that; an absolute
      // maxTokens crossing is a real count and does fire.
      const result = getContextPct(transcriptPath, env, { home, sessionId: payload.session_id, lines: lines || undefined });
      const over = overThreshold(result, settings);
      if (over === 'pct' || over === 'tokens') {
        const now = Date.now();
        writeLatch(home, tag, {
          fired: true, firedAt: now, firedPct: result.pct, firedVia: 'stop-' + over,
          lastNagPct: result.pct, lastNagAt: now, softFired: latch.softFired === true,
        });
        // A handover from an EARLIER arm/session can already exist here (rare,
        // e.g. a manually-written one) -- decisiveSuffixFor() only speaks up
        // when sessionHandover() actually finds one for THIS session.
        emit(buildFireDirective(result, over, payload, settings.maxTokens) + decisiveSuffixFor(payload, settings, lines));
        return;
      }
      emit();
      return;
    }

    if (!settings.nag) { emit(); return; }

    const result = getContextPct(transcriptPath, env, { home, sessionId: payload.session_id, lines: lines || undefined });
    if (!result || !Number.isFinite(result.pct)) { emit(); return; }

    const now = Date.now();
    if (!overThreshold(result, settings)) {
      writeLatch(home, tag, { fired: false }); // dropped back below -> re-arm
      emit();
      return;
    }

    // RE-NAG RULE (v0.108.3): nag again only when context has RISEN at least
    // nagStepPct points past the last nag's baseline (lastNagPct), OR at a
    // quiet pause once nagQuietMin has elapsed since the last nag of either
    // kind — and never repeat the identical pct/text within the same step
    // (lastPauseNagPct is the rounded pct the last pause nag showed).
    const lastNagAt = Number.isFinite(latch.lastNagAt) ? latch.lastNagAt : 0;
    const lastNagPct = Number.isFinite(latch.lastNagPct) ? latch.lastNagPct : (Number.isFinite(latch.firedPct) ? latch.firedPct : settings.pct);
    const shownPct = Math.round(result.pct);
    const risen = result.pct >= lastNagPct + settings.nagStepPct;
    const quietElapsed = (now - lastNagAt) >= settings.nagQuietMin * 60 * 1000;
    if (!risen && !quietElapsed) { emit(); return; }
    if (!risen && latch.lastPauseNagPct === shownPct) { emit(); return; } // same step, identical text

    const open = hasOpenTasks(lines);
    if (open === true) { emit(); return; } // KNOWN open work -> don't interrupt it

    if (hasRecentSpawn(tag, now)) { emit(); return; } // a subagent spawned recently

    writeLatch(home, tag, Object.assign({}, latch, {
      lastNagAt: now, lastPauseNagPct: shownPct, lastNagPct: risen ? result.pct : latch.lastNagPct,
    }));
    emit(buildPauseNag(result.pct, payload) + decisiveSuffixFor(payload, settings, lines));
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
