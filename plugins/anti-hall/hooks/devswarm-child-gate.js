#!/usr/bin/env node
// anti-hall :: devswarm-child-gate (Stop hook, child workspace only)
//
// The Stop-side complement to devswarm-child-role.js (SessionStart). When a
// DevSwarm CHILD workspace sub-orchestrator is about to stop, force it — a CAPPED
// number of times — to emit a heartbeat / self-report to its parent BEFORE going
// idle, so a child that finishes a turn pings the parent instead of silently
// dropping off the parent's radar and later reading as stale/neglected.
//
// This satisfies the heartbeat-authorship rule (PLAN.md Phase 2 correction):
// heartbeats are emitted by the working session's OWN turn (this hook fires on
// the child's Stop), NEVER by a background daemon on the child's behalf. The
// forced-ack is the mechanism — it blocks the Stop with a reason telling the
// child to run `hivecontrol workspace message-parent`.
//
// CAPPED + SELF-RESETTING (loop-safe): we block at most MAX_BLOCKS times inside a
// single stop episode, then yield (allow the stop) so we can NEVER hard-loop the
// child. The cap is tracked in this hook's OWN DISTINCT state file (separate from
// task-guard's last-stop-taskset-* and from the liveness verdict). It resets after
// RESET_MS of no forced block — i.e. once the child has done real work and reaches
// a genuinely new stop episode, the heartbeat forcing re-arms.
//
// Gates (identical role detection to devswarm-child-role.js):
//   - liveness supervisor ACTIVE (devswarm-detect: DEVSWARM_REPO_ID / mode), AND
//   - this session is a CHILD workspace (devswarm-role: DEVSWARM_SOURCE_BRANCH
//     non-empty).
// Primary sessions, non-DevSwarm sessions, and any error -> silent no-op, exit 0
// (byte-identical to today). Honors the user's explicit skip marker.
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { hook_event_name, session_id, stop_hook_active, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to force the heartbeat, or
//            nothing (allow the stop).
//   exit 0 : always (fail-open on ANY error).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');
const { isSkipped } = require('./skip-guard.js');

// How many times a single stop episode may be forced to heartbeat before we
// yield. One forced-ack is usually enough; a small budget lets a child that
// didn't actually report on the first bounce get one more chance, and the cap
// then guarantees the child is never hard-looped.
const MAX_BLOCKS = 2;

// After this long with no forced block, the cap re-arms: a genuinely new stop
// episode (the child worked for a while, then stopped again) gets a fresh
// heartbeat forcing. Within a tight bounce-loop this window has NOT elapsed, so
// the cap holds and the loop terminates.
const RESET_MS = 5 * 60 * 1000;

function stateFileFor(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_');
  // Own DISTINCT state file, namespaced under devswarm/ so it never collides with
  // task-guard's ~/.anti-hall/last-stop-taskset-* or the liveness verdict files.
  return path.join(os.homedir(), '.anti-hall', 'devswarm', 'child-gate', safe + '.json');
}

function readState(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return {
        blocks: Number.isFinite(parsed.blocks) ? parsed.blocks : 0,
        lastBlockAt: Number.isFinite(parsed.lastBlockAt) ? parsed.lastBlockAt : 0,
      };
    }
  } catch (_) { /* first time / unreadable -> fresh state */ }
  return { blocks: 0, lastBlockAt: 0 };
}

function writeState(stateFile, state) {
  // Atomic tmp + rename so a crash mid-write can never leave a torn state file.
  // Returns true iff the cap state was persisted; false lets the caller FAIL OPEN
  // (a guard that cannot track its own cap must never block — see main()).
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile);
    return true;
  } catch (_) {
    return false; // could not persist the cap -> caller fails open (never blocks)
  }
}

function main() {
  // Read stdin (fd 0 — cross-platform; /dev/stdin is Windows-unsafe).
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    return; // no stdin -> fail-open
  }

  // Escape hatch: honor an explicit, user-consented skip.
  if (isSkipped('devswarm-child-gate')) return;

  // ROLE GATE: only a DevSwarm child workspace with the supervisor active. A
  // Primary / non-DevSwarm session is a byte-identical no-op (matches
  // devswarm-child-role.js). Env-based, so it works even before stdin is parsed.
  if (!isDevswarmActive(process.env)) return;
  if (!isChildWorkspace(process.env)) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    return; // malformed stdin -> fail-open (never block on a parse error)
  }

  const now = Date.now();
  // Session key: prefer session_id; fall back to a stable hash of the transcript
  // path so the per-session cap still works when session_id is absent.
  const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
    (payload && payload.transcript_path
      ? crypto.createHash('sha1').update(String(payload.transcript_path)).digest('hex').slice(0, 16)
      : 'unknown');

  const stateFile = stateFileFor(sessionId);
  const state = readState(stateFile);

  // Cap reset: once RESET_MS has elapsed since the last forced block, treat this
  // as a genuinely new stop episode and re-arm the heartbeat forcing. lastBlockAt
  // defaults to 0, so the very first Stop always arms.
  let blocks = state.blocks;
  if ((now - state.lastBlockAt) >= RESET_MS) blocks = 0;

  // Cap: after MAX_BLOCKS forced-acks in this episode, yield — allow the stop.
  // Do NOT rewrite lastBlockAt here, so the RESET_MS window keeps measuring from
  // the last ACTUAL block and can still re-arm later (never a hard loop).
  if (blocks >= MAX_BLOCKS) return;

  // Force the heartbeat: persist the cap BEFORE blocking so it is honored even if
  // the child re-stops. If the cap state can't be persisted (e.g. unwritable HOME),
  // FAIL OPEN — do NOT block. A guard that blocks while unable to track its own cap
  // would block EVERY Stop forever (fail-closed). Mirrors devswarm-parent-gate.js.
  if (!writeState(stateFile, { blocks: blocks + 1, lastBlockAt: now })) return;

  const reason =
    'DEVSWARM CHILD WORKSPACE — before you stop, emit a heartbeat / self-report to ' +
    'your parent orchestrator so you do not silently drop off its radar and later ' +
    'read as stale. Run `hivecontrol workspace message-parent` with a one-line status ' +
    '(e.g. "done — awaiting next task", "blocked on X", or "idle — reassign or archive ' +
    'me"), THEN stop. This keeps the parent\'s task list honest instead of leaving you ' +
    'unnoticed.';

  // fs.writeSync(1): a synchronous write to fd 1 — process.stdout.write races the
  // async pipe flush with process.exit() on macOS node 18/20 (project convention).
  try { fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n'); } catch (_) {}
}

try {
  main();
} catch (_) {
  // Fail-open: any error must never block the child.
}
process.exit(0);
