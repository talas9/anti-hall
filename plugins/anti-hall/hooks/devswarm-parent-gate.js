#!/usr/bin/env node
// anti-hall :: devswarm-parent-gate (Stop hook, Primary only, loop-safe)
//
// Workaround for claude-code#39755 — the failure mode where a DevSwarm Primary
// orchestrator ENDS ITS TURN while a child workspace still has an unread inbox
// backlog past its cursor, or while the liveness supervisor has already judged a
// child STALE/ESCALATED. This gate fires on Stop and, for the PRIMARY session
// only, forces a bounded acknowledgement so the neglected child is attended to
// rather than silently abandoned off the Primary's task list.
//
// WHAT IT READS (audit P1-C — the Stop path has a ~30s budget and MUST stay
// cheap): it NEVER re-runs computeLiveness() and NEVER shells out to git. Both
// signals come from files the supervisor / consumer already wrote:
//   - UNREAD backlog: the durable NDJSON inbox + its cursor, via the read/ack
//     primitive (companion/lib/devswarm-inbox-cursor.js readUnread) — pure fs,
//     the SAME projection the staleness detector consumes, no git.
//   - STALE / ESCALATED: the supervisor's already-written per-workspace verdict
//     file (companion/lib/liveness.js livenessPathFor -> ~/.anti-hall/devswarm/
//     liveness/<id>.json). Read-only. `escalated` is terminal/sticky (per
//     recovery.js) and counts as BLOCKING — same severity class as `stale`,
//     because escalation means the automatic poke already failed and a human
//     must look (P1-C default: yes, an escalated child also blocks the gate).
// summary.json (the Phase-2 aggregate read-surface, P1-B) is the eventual home
// of these verdicts; in Phase 1 the per-workspace verdict files ARE the
// supervisor's already-written verdicts, so they are read directly.
//
// INERTNESS (audit P1-D): this hook is a NO-OP until BOTH workspace descriptors
// exist (~/.anti-hall/devswarm/workspaces/*.json) AND a populated durable inbox
// exists. A public/standalone anti-hall user with no descriptors and no inbox
// tooling running gets zero output, exit 0 — byte-identical to today. It is not
// self-sufficient; it depends on Phase 2's ingest daemon (or a consumer's
// equivalent) to have anything to act on.
//
// CLEAR PATH (audit P1-A): the non-skip escape is a real inbox read/ack that
// advances the cursor — the primitive in companion/lib/devswarm-inbox-cursor.js
// (advanceCursor(inboxPath, cursorPath) marks all current messages read; ackTo
// for a partial ack). The block reason states this exact path. skip-guard's TTL
// (~/.anti-hall/skip.json, guard name "devswarm-parent-gate") is the last-resort
// user-consented escape hatch.
//
// LOOP-SAFETY: a bounded per-SET forced-ack cap. The blocking SET is signed
// (workspace id + unread count + verdict status). The cap counter RESETS when
// that signature changes (new unread arrived, a child newly went stale, a
// partial ack moved a count) so each distinct neglect state gets its own small
// budget; once the SAME set has been forced-acked CAP times we go quiet. This
// can never hard-loop even if the model ignores the block. Default cap 3
// (clamped 2..5 via ANTIHALL_DEVSWARM_PARENT_GATE_CAP).
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { session_id?, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to block, or nothing.
//   exit 0 : always — fail-open on any error so a bug never hard-loops Claude.
//
// Pure Node built-ins. Cross-platform. Fail-open on EVERY error.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { isSkipped } = require('./skip-guard.js');
const { isDevswarmActive } = require('./lib/devswarm-detect.js');
const { isChildWorkspace } = require('./lib/devswarm-role.js');
// REUSE (never reimplement): descriptor discovery, the read/ack primitive, and
// the verdict-file path helper all already exist.
const { readDescriptors } = require('../companion/devswarm-supervisor.js');
const { readUnread } = require('../companion/lib/devswarm-inbox-cursor.js');
const { livenessPathFor } = require('../companion/lib/liveness.js');

const GUARD_NAME = 'devswarm-parent-gate';
const DEFAULT_CAP = 3; // forced-acks per distinct blocking SET

// resolveCap(env) -> int in [2,5]. Absent / non-numeric / out-of-range falls
// back to the default (fail-open: a typo never disables or unbounds the gate).
function resolveCap(env) {
  const raw = (env || {}).ANTIHALL_DEVSWARM_PARENT_GATE_CAP;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = parseInt(raw.trim(), 10);
    if (Number.isFinite(n)) return Math.max(2, Math.min(5, n));
  }
  return DEFAULT_CAP;
}

// readVerdictStatus(id, home) -> string | null. Reads ONLY the supervisor's
// already-written per-workspace verdict file (no computeLiveness, no git).
// Absent / unreadable / malformed -> null (fail-safe: no verdict = not blocking
// on the liveness axis).
function readVerdictStatus(id, home) {
  try {
    const p = livenessPathFor(id, home); // throws on an unsafe id
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v.status === 'string' ? v.status : null;
  } catch (_) {
    return null;
  }
}

// stateFileFor(sessionId, home) — DISTINCT per-session loop-state, under
// ~/.anti-hall/devswarm/parent-gate/ (never the user's project tree; survives
// `cd`; keyed by session so dedupe is per-session).
function stateFileFor(sessionId, home) {
  const safe = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(home, '.anti-hall', 'devswarm', 'parent-gate', safe + '.json');
}

function main() {
  // Read stdin (fd 0 — cross-platform; /dev/stdin is Windows-unsafe).
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { return; }

  // Escape hatch: an explicit, user-consented skip outranks the guard.
  if (isSkipped(GUARD_NAME)) return;

  // Primary + DevSwarm-active only. A child workspace, a non-DevSwarm session, or
  // an inactive supervisor is a silent no-op.
  if (!isDevswarmActive(process.env)) return;
  if (isChildWorkspace(process.env)) return;

  let payload = {};
  try { payload = JSON.parse(raw); } catch (_) { return; }

  const home = os.homedir();

  // INERT until descriptors exist (P1-D). No descriptors -> nothing to gate.
  let descriptors = [];
  try { descriptors = readDescriptors(home) || []; } catch (_) { descriptors = []; }
  if (descriptors.length === 0) return;

  // Build the blocking SET: workspaces with unread backlog past their cursor OR a
  // stale/escalated verdict. All reads are pure fs (no git, no computeLiveness).
  const blocking = [];
  for (const d of descriptors) {
    let unreadCount = 0;
    try {
      const u = readUnread(d.inboxPath, d.cursorPath);
      if (u && u.known && u.count > 0) unreadCount = u.count;
    } catch (_) { /* unreadable inbox -> fail-safe: no unread */ }

    const status = readVerdictStatus(d.id, home);
    const staleOrEscalated = status === 'stale' || status === 'escalated';

    if (unreadCount > 0 || staleOrEscalated) {
      blocking.push({ id: String(d.id), unread: unreadCount, status: staleOrEscalated ? status : '' });
    }
  }

  const stateFile = stateFileFor(payload.session_id, home);

  // Nothing neglected -> clear any prior loop-state and stay quiet.
  if (blocking.length === 0) {
    try { fs.unlinkSync(stateFile); } catch (_) {}
    return;
  }

  // Signature of the blocking SET. The cap RESETS whenever this changes (P1: cap
  // resets when the unread SET changes). Includes unread counts AND verdict
  // status so a new message, a fresh stale/escalation, or a partial ack all
  // re-open the small budget.
  const sig = crypto.createHash('sha1').update(
    blocking
      .map((b) => b.id + '\x00' + b.unread + '\x00' + b.status)
      .sort()
      .join('\x1f')
  ).digest('hex');

  // Load prior loop-state { sig, blocks }.
  let lastSig = '';
  let blocks = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      lastSig = typeof parsed.sig === 'string' ? parsed.sig : '';
      blocks = Number.isFinite(parsed.blocks) ? parsed.blocks : 0;
    }
  } catch (_) { /* first time / cleared */ }

  // Per-SET cap: the counter is only meaningful while the set is unchanged.
  const effectiveBlocks = sig === lastSig ? blocks : 0;
  const cap = resolveCap(process.env);
  if (effectiveBlocks >= cap) return; // this exact set has been forced-acked enough — go quiet

  // Persist BEFORE blocking so the cap is honored even if the model re-stops with
  // the same set. Can't persist -> fail-open (skip the block to avoid any loop).
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ sig, blocks: effectiveBlocks + 1 }), 'utf8');
  } catch (_) { return; }

  const reason = buildReason(blocking);
  try { fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n'); } catch (_) {}
}

// buildReason(blocking) -> string. Names up to 5 neglected workspaces with their
// unread counts / verdict status, then states the EXACT non-skip clear path (the
// read/ack primitive) plus the skip-guard escape. Workspace ids are already
// path-safe (readDescriptors filters via isSafeId: /^[A-Za-z0-9._-]+$/), so they
// carry no control chars / injection surface.
function buildReason(blocking) {
  const shown = blocking.slice(0, 5).map((b) => {
    const bits = [];
    if (b.unread > 0) bits.push(b.unread + ' unread');
    if (b.status) bits.push(b.status);
    return b.id + ' (' + bits.join(', ') + ')';
  }).join('; ');
  const more = blocking.length > 5 ? ' (and ' + (blocking.length - 5) + ' more)' : '';

  const anyUnread = blocking.some((b) => b.unread > 0);
  const anyStale = blocking.some((b) => b.status === 'stale' || b.status === 'escalated');

  let body =
    'DEVSWARM NEGLECT: ' + blocking.length + ' child workspace(s) still need attention ' +
    'before this Primary turn ends: ' + shown + more + '. ';
  if (anyUnread) {
    body +=
      'CLEAR the unread backlog by READING each workspace\'s unread inbox message(s), ' +
      'ACTING on them, then ADVANCING its cursor with the read/ack primitive at ' +
      'plugins/anti-hall/companion/lib/devswarm-inbox-cursor.js ' +
      '(advanceCursor(inboxPath, cursorPath) marks all current messages read; ' +
      'ackTo for a partial ack). ';
  }
  if (anyStale) {
    body +=
      'A stale child is wedged (claude-code#39755); an escalated one already ' +
      'exhausted the automatic poke and needs a human — attend to it (on-demand ' +
      'devswarm-recover for a confirmed wedge, or reassign/archive). ';
  }
  body +=
    'If this is intentional, say so explicitly. Escape hatch: the user may direct a ' +
    'skip via ~/.anti-hall/skip.json ("devswarm-parent-gate").';
  return body;
}

try {
  main();
} catch (_) {
  // Fail-open: a bug here must never block or hard-loop the session.
}
process.exit(0);
