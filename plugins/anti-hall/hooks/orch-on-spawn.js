#!/usr/bin/env node
'use strict';
// anti-hall :: orch-on-spawn (PreToolUse Agent|Task|Workflow)
//
// EXPERIMENTAL, opt-in (context.orchFullOn=spawn): the default (auto) sends ORCH_FULL inline at SessionStart and
// leaves the marker `none`, so this hook stays silent. It becomes the default only after the live probes
// (PreToolUse additionalContext reaches the coordinator, real transcript line shape, Workflow discriminator).
//
// Delivers the FULL orchestration ruleset (ORCH_FULL, rules A-N) once per context epoch, on the
// coordinator's first spawn. SessionStart (verify-first-orch.js) sent only ORCH_COMPACT and wrote a
// marker saying `pending`; this hook is the other half of that contract (cost-trim D3).
//
// Rules:
//   - Silent unless context.verifyFirstOrchestration is on, the guard is not skipped
//     (~/.anti-hall/skip.json "orch-on-spawn"), and the marker for this session says `pending`.
//     A missing/unparseable marker means silence: the inline compact lines already carry G/L/M/N.
//   - It never recomputes Primary/level gates; it obeys the decision SessionStart stored.
//   - Silent, and no claim, when the payload is a subagent's (isSubagentByPayload: agent_id /
//     agent_type). Only the coordinator's own spawn call may take the claim.
//   - ONE sender per epoch: the first caller to create orch-full-<sid>-<epochId>-claim.json with
//     fs 'wx' wins (parallel spawns race on O_EXCL, never read-modify-write). A retry is a second
//     slot (-claim2.json), opened only after a 2-minute lease and only if the transcript shows no
//     delivered copy of this epoch's token (a crash or a denied spawn after the claim must not lose
//     the doctrine for the whole epoch).
//   - Registered on PreToolUse (the plan's fallback when the Phase 0 landing probe has not shown
//     PostToolUse equal): background spawns get the text at launch. The hook echoes the event name it
//     is given, so a PostToolUse registration would work unchanged.
//
// Contract: stdin JSON { session_id, transcript_path, tool_name, hook_event_name, ... }; stdout JSON
// { hookSpecificOutput: { hookEventName, additionalContext } } or nothing. Exit 0 always (fail-open).

const fs = require('fs');

// Injectable clock: only under ANTIHALL_TEST_ISOLATION=1 (tests and the injection profile).
function now() {
  const e = process.env;
  if (e.ANTIHALL_TEST_ISOLATION === '1' && e.ANTIHALL_TEST_NOW_MS) {
    const n = Number(e.ANTIHALL_TEST_NOW_MS);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

const SPAWN_TOOLS = new Set(['Agent', 'Task', 'Workflow']);

function main() {
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return; }
  if (!payload || typeof payload !== 'object') return;
  if (typeof payload.tool_name === 'string' && !SPAWN_TOOLS.has(payload.tool_name)) return;
  if (typeof payload.session_id !== 'string' || !payload.session_id) return;

  try { if (!require('./lib/settings.js').enabled('context', 'verifyFirstOrchestration')) return; } catch (_) { /* run */ }
  try { if (require('./skip-guard.js').isSkipped('orch-on-spawn')) return; } catch (_) { /* proceed */ }
  try { if (require('./verify-first-core.js').protocolLevel() === 'full') return; } catch (_) { return; }
  try { if (require('./coordinator-detect.js').isSubagentByPayload(payload)) return; } catch (_) { return; }

  const state = require('./lib/orch-full-state.js');
  const marker = state.readMarker(payload.session_id);
  if (!marker || marker.decision !== 'pending') return;
  // Keep a live session's marker out of the 7-day prune: touch it on every spawn read.
  try { const nowS = Date.now() / 1000; require('fs').utimesSync(state.markerPath(payload.session_id), nowS, nowS); } catch (_) { /* best-effort */ }

  const t = now();
  let won = state.tryClaim(state.claimPath(payload.session_id, marker.epochId, 1), t);
  if (!won) {
    // Retry slot: only after the lease, only when no delivered copy is visible.
    // Once the second slot exists the epoch is done: return before any transcript read.
    if (fs.existsSync(state.claimPath(payload.session_id, marker.epochId, 2))) return;
    const at = state.claimAt(state.claimPath(payload.session_id, marker.epochId, 1));
    if (at === null || t - at < state.LEASE_MS) return;
    // Retry only on a CONCLUSIVE absence (false); unknown (null) and delivered (true) both stay silent.
    if (state.seen(payload.transcript_path, marker.epochId, marker.sentAt) !== false) return;
    won = state.tryClaim(state.claimPath(payload.session_id, marker.epochId, 2), t);
  }
  if (!won) return;

  const core = require('./verify-first-core.js');
  const event = typeof payload.hook_event_name === 'string' && payload.hook_event_name ? payload.hook_event_name : 'PreToolUse';
  const text = core.ORCH_FULL + '\n' + state.tokenFor(marker.epochId);
  fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: never block a spawn.
}
process.exit(0);
