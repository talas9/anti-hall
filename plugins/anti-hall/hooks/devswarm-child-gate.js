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
// SOUND FORCED-ACK (v0.54.1 correction — reverts the v0.54.0 "fresh heartbeat
// satisfies the Stop gate" logic, which FALSE-SILENCED a child that worked <5min
// then stopped WITHOUT message-parent): the turn-START heartbeat written by
// devswarm-child-turn is NOT a valid "I reported my stop-state" signal — it says
// only that a turn began, not that the child pinged its parent before going idle.
// Treating it as satisfaction let an unreported child drop off the parent's radar.
// So this gate ALWAYS demands at least one real report per unchanged blocking
// state (never false-silence), bounded ONLY by the capped forced-ack below.
//
// v0.54.2 IMPROVEMENT (not yet built): a proper "satisfied-by-actual-
// message-parent-report" marker — a distinct signal written by the child's own
// `hivecontrol workspace message-parent` call — could let a genuinely-reported
// child skip the nag WITHOUT the turn-start heartbeat's false-silence. Until that
// exists, the bounded forced-ack is the only correct behavior.
//
// INBOUND GATE (#29): alongside the outbound message-parent forcing above, this
// hook also checks whether the child has unpulled/unread PARENT messages waiting.
// When it does, the SAME forced-ack reason (still gated by the SAME MAX_BLOCKS
// cap / state file below — this is not a second, independent budget) is extended
// to tell the child to `inbox pull` / read / ack the backlog before it stops, so a
// child cannot go idle sitting on an unread parent message. The check is layered:
//   1. Durable (pure fs, non-destructive): readUnread() on the child's own
//      descriptor inbox (workspaces/<id>.json -> inboxPath/cursorPath) — the same
//      primitive devswarm-child-turn.js already uses.
//   2. STRICT (default ON; ANTIHALL_DEVSWARM_CHILD_GATE_STRICT=0 disables): when
//      the durable check finds nothing, ONE bounded, NON-DESTRUCTIVE `hivecontrol
//      workspace message-count` spawn (finite timeout, NEVER read-messages /
//      monitor) catches a native backlog the child has never `inbox pull`ed. Only
//      probed when we are about to block anyway (never on the cap-exhausted
//      yield path), so a healthy child pays zero extra spawn cost.
// Fail-open throughout: any probe error/timeout/missing binary -> treated as "no
// unread" (never blocks on an unknown state).
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
const { spawnSync } = require('child_process');

const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');
const { isSkipped } = require('./skip-guard.js');
const { devswarmRoot, isSafeId } = require('../companion/lib/liveness.js');
const { readUnread } = require('../companion/lib/devswarm-inbox-cursor.js');

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

// ONE bounded, NON-DESTRUCTIVE probe timeout — must never wedge a Stop.
const MESSAGE_COUNT_TIMEOUT_MS = 5000;

// strictEnabled(env) -> bool. ANTIHALL_DEVSWARM_CHILD_GATE_STRICT default ON;
// '0' disables the native fallback probe (pure-fs durable-unread check only).
function strictEnabled(env) {
  const e = env || {};
  const raw = e.ANTIHALL_DEVSWARM_CHILD_GATE_STRICT;
  return String(raw === undefined ? '1' : raw).trim() !== '0';
}

// readDurableUnread(env, home) -> { known, count }. NON-DESTRUCTIVE unread check
// on the child's OWN durable descriptor inbox (workspaces/<DEVSWARM_BUILDER_ID>
// .json -> inboxPath/cursorPath), via the same inbox-cursor primitive devswarm-
// child-turn.js uses. Pure fs — never drains the native queue, never spawns
// hivecontrol. Fail-safe: ANY error -> { known: false, count: 0 }.
function readDurableUnread(env, home) {
  try {
    const id = env.DEVSWARM_BUILDER_ID;
    if (typeof id !== 'string' || !isSafeId(id)) return { known: false, count: 0 };
    const descPath = path.join(devswarmRoot(home), 'workspaces', id + '.json');
    let desc;
    try { desc = JSON.parse(fs.readFileSync(descPath, 'utf8')); } catch (_) { return { known: false, count: 0 }; }
    if (!desc || typeof desc !== 'object' || !desc.inboxPath) return { known: false, count: 0 };
    const u = readUnread(desc.inboxPath, desc.cursorPath);
    return { known: !!u.known, count: u.known ? u.count : 0 };
  } catch (_) {
    return { known: false, count: 0 };
  }
}

// probeNativeMessageCount(env) -> int | null. ONE bounded, NON-DESTRUCTIVE
// `hivecontrol workspace message-count` spawn (finite timeout, NEVER read-messages
// or monitor). Returns null on any error/timeout/non-zero exit/unparseable output
// (unknown -> fail-open, never counted as unread).
function probeNativeMessageCount(env) {
  try {
    const r = spawnSync('hivecontrol', ['workspace', 'message-count'], {
      encoding: 'utf8', timeout: MESSAGE_COUNT_TIMEOUT_MS, env,
    });
    if (r.error || r.status !== 0 || r.signal) return null;
    const m = String(r.stdout || '').trim().match(/-?\d+/);
    if (!m) return null;
    const n = parseInt(m[0], 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (_) {
    return null;
  }
}

// hasUnreadParentMessages(env, home) -> bool. Durable (pure-fs) check FIRST; when
// it shows nothing AND STRICT mode is enabled, a bounded native message-count
// probe catches a backlog the child has never `inbox pull`ed. Fail-open: any probe
// error -> false (never blocks on an unknown state).
function hasUnreadParentMessages(env, home) {
  const durable = readDurableUnread(env, home);
  if (durable.known && durable.count > 0) return true;
  if (!strictEnabled(env)) return false;
  const native = probeNativeMessageCount(env);
  return Number.isFinite(native) && native > 0;
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

  // NO heartbeat-satisfaction check (reverted — see header): the child's turn-start
  // heartbeat is NOT proof it reported its stop-state, so it can never silence this
  // gate. An unreported child ALWAYS reaches the capped forced-ack below.

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

  // INBOUND check only now that we are actually about to block (never on the
  // cap-exhausted yield path above) — a healthy child never pays the probe cost.
  const unreadPending = hasUnreadParentMessages(process.env, os.homedir());
  const inboundPrefix = unreadPending
    ? 'DEVSWARM CHILD INBOX — you have unpulled/unread parent message(s): run ' +
      '`node scripts/devswarm.js inbox pull <DEVSWARM_BUILDER_ID>` (or `inbox read` ' +
      'if already pulled), then `inbox ack` once addressed — BEFORE you stop. '
    : '';

  const reason =
    inboundPrefix +
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
