#!/usr/bin/env node
// anti-hall :: ORCHESTRATION DISCIPLINE ruleset
//             (SessionStart [startup/resume/clear/compact])
//
// The companion to verify-first-full.js (the verify-first FOUNDATION). This hook
// carries the orchestration doctrine — rules A-N and, for a DevSwarm Primary only,
// rule W (the child-workspace tier). Together the two SessionStart hooks deliver
// the full protocol the single verify-first-full.js used to emit.
//
// WHY A SECOND HOOK (the ~10,000-char injection cap):
//   Claude Code caps a hook's additionalContext at ~10,000 chars and SPILLS the
//   overflow to a file (only ~2k reaches the model inline). The combined
//   foundation + orchestration payload was ~15.3k, so the orchestration rules
//   never landed inline. The cap is PER HOOK COMMAND — so the doctrine is split
//   across two SessionStart hooks, each well under the cap (this hook ~7.7k /
//   ~8.1k with rule W; see docs/KB.md). ZERO content was deleted by the split.
//
// COMPACTION SURVIVAL: registered ONLY on SessionStart (no matcher), which
// re-fires with source="compact" after compaction — same mechanism as
// verify-first-full.js. Echoes back the parsed hookEventName (F-20).
//
// CONDITIONAL DELIVERY (cost-trim Phase 3, plan D3): the text lives in verify-first-core.js.
//   - context.protocolLevel=full, a DevSwarm Primary, Codex or any not-confident platform
//     (lib/auto-handover-text.js isClaudeConfident: needs the `--host=claude` argv flag that only
//     the Claude hooks.json command carries) -> ORCH_FULL inline here, today's text.
//   - context.orchFullOn=auto (default) and session -> ORCH_FULL inline here, next to the compact core.
//     Spawn-time delivery is EXPERIMENTAL and opt-in (orchFullOn=spawn) until the live probes (does a
//     PreToolUse additionalContext reach the coordinator, the real transcript line shape, the Workflow
//     discriminator) prove it: Claude + confident + spawn -> ORCH_COMPACT here, and a per-session marker
//     (lib/orch-full-state.js) tells orch-on-spawn.js to send ORCH_FULL once on the first Agent/Task/
//     Workflow spawn of this epoch. This hook runs on EVERY SessionStart source, so each
//     compaction/clear/resume re-arms the marker with a fresh epochId.
//   - Codex (positive detectPlatform evidence) + context.codexOrchFullOn=spawn (opt-in, default session): the same
//     compact-at-start + marker `pending` flow, delivered on the first spawn_agent PreToolUse (orch-on-spawn.js).
//   - orchFullOn=off -> ORCH_COMPACT only.
//   The marker says `none` whenever this hook sent full text (or nothing), so a stale `pending`
//   never survives into a new epoch.
//
// Contract:
//   stdin  : JSON { hook_event_name, source?, ... }
//   stdout : JSON { hookSpecificOutput.additionalContext }
//   exit 0 : always (never blocks). Fail-open on any error.

'use strict';
require('./lib/judge-child-exit');

const fs = require('fs');
const core = require('./verify-first-core');

// isDevswarmPrimary(env, cwd) — the shared gate (hooks/lib/primary-tier.js): DevSwarm Primary, devswarm.dispatchTierText on,
// and not a repo that forbids workspaces. Fail-open to FALSE => the baseline text only.
function isDevswarmPrimary(env, cwd) {
  return require('./lib/primary-tier.js').primaryTierTextOn(env, cwd);
}

function setting(key, dflt) {
  try { return require('./lib/settings.js').get('context', key, dflt); } catch (_) { return dflt; }
}

function emit(event, text) {
  const out = { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  // SYNCHRONOUS write to fd 1 (same rationale as verify-first-full.js): avoids the
  // macOS node 18/20 async-pipe-flush truncation when process.exit(0) races a
  // buffered stdout write. fs.writeSync blocks until every byte is handed to the pipe.
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

function main() {
  // Read stdin FIRST: the kill-switch path below still has to clear a pending marker.
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    raw = '';
  }

  // Parse the firing event (F-20: no brittle substring match). Registered ONLY on
  // SessionStart, so SessionStart is the expected value and the safe default.
  let event = 'SessionStart';
  let cwd;
  let payload = null;
  try {
    payload = JSON.parse(raw);
    cwd = payload && payload.cwd;
    const name = payload && typeof payload.hook_event_name === 'string'
      ? payload.hook_event_name
      : '';
    if (name === 'SessionStart') {
      event = 'SessionStart';
    }
  } catch (_) {
    event = 'SessionStart';
    payload = null;
  }

  let confident = false;
  try {
    confident = require('./lib/auto-handover-text.js').isClaudeConfident(payload, process.argv.slice(2));
  } catch (_) {
    confident = false;
  }
  const state = require('./lib/orch-full-state.js');
  // writeNone: clear any pending marker from a previous epoch. Only a confident (Claude) session
  // has a marker; everyone else never gets one, so nothing can be pending.
  // A not-confident session normally has no marker; an existing one (stale `pending` from an earlier
  // epoch of the same session id) is still overwritten so it can never trigger a spawn-time send.
  const writeNone = () => {
    if (confident) { state.writeMarker(payload.session_id, 'none'); return; }
    try {
      const sid = payload && typeof payload.session_id === 'string' ? payload.session_id : '';
      if (sid && state.readMarker(sid)) state.writeMarker(sid, 'none');
    } catch (_) { /* best-effort */ }
  };

  // Settings switch context.verifyFirstOrchestration (0.108.4): off -> no-op. Fail-open: any error runs the hook.
  try {
    if (!require('./lib/settings.js').enabled('context', 'verifyFirstOrchestration')) { writeNone(); return; }
  } catch (_) { /* run */ }

  let codex = false;
  try { codex = require('./lib/auto-handover-text.js').detectPlatform(payload) === 'codex'; } catch (_) { codex = false; }
  const orchFull = codex ? core.ORCH_FULL_CODEX : core.ORCH_FULL;
  const primary = isDevswarmPrimary(process.env, cwd);
  // protocolLevel=full: today's text, byte for byte; orchFullOn is ignored.
  if (core.protocolLevel() === 'full') {
    writeNone();
    emit(event, primary ? (codex ? core.ORCH_FULL_PRIMARY_CODEX : core.ORCH_FULL_PRIMARY) : orchFull);
    return;
  }
  // A DevSwarm Primary keeps ORCH_FULL + W inline (its workspace-tier rule must be at primacy).
  if (primary) {
    writeNone();
    emit(event, codex ? core.ORCH_FULL_PRIMARY_CODEX : core.ORCH_FULL_PRIMARY);
    return;
  }

  let mode = String(setting('orchFullOn', 'auto'));
  if (mode === 'auto') mode = 'session'; // spawn delivery is opt-in until proven live
  if (mode === 'spawn' && !confident) mode = 'session'; // explicit spawn is coerced when not confident
  // Codex: orchFullOn is Claude-only; the separate, opt-in codexOrchFullOn=spawn defers ORCH_FULL to the
  // first spawn_agent PreToolUse. Needs POSITIVE Codex evidence (detectPlatform) and a session id.
  if (codex && !confident && mode !== 'off') {
    mode = 'session';
    const sid = payload && typeof payload.session_id === 'string' ? payload.session_id : '';
    if (sid && String(setting('codexOrchFullOn', 'session')) === 'spawn') mode = 'spawn';
  }
  if (mode === 'spawn') {
    // orch-on-spawn honours the same skip.json switch; a skipped guard sends the full text here.
    try { if (require('./skip-guard.js').isSkipped('orch-on-spawn')) mode = 'session'; } catch (_) { /* proceed */ }
  }

  if (mode === 'off') {
    writeNone();
    emit(event, core.orchCompact(false, undefined, codex));
    return;
  }
  if (mode === 'spawn') {
    // Marker first: ORCH_COMPACT promises the spawn delivery only when the marker is `pending`.
    const w = state.writeMarker(payload.session_id, 'pending');
    if (w.ok) {
      emit(event, core.orchCompact(true, undefined, codex));
      return;
    }
    // Unwritable marker: nothing could deliver ORCH_FULL later, so send it inline now.
  }
  writeNone();
  emit(event, orchFull);
}

try {
  main();
} catch (_) {
  // Fail-open: never block session start or compaction.
}
process.exit(0);
