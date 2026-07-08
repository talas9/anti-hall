'use strict';
// anti-hall :: liveness — outbound-staleness detector + atomic verdict writer.
// Workaround for claude-code#39755.
//
// STALE only when BOTH outbound signals (the target session's OWN transcript
// mtime AND git/worktree activity) are PRESENT and each idle past the threshold,
// AND the workspace has a pending unread backlog past its cursor. A workspace idle
// because it has nothing to do is NOT stale. Fail direction = NOT stale (never
// nominate a healthy workspace for a kill). The inbound heartbeat is deliberately
// NOT used — it is blind to this failure mode (the wedged child stopped consuming
// inbound too). Liveness is uuid-SCOPED: only <sessionId>.jsonl is stat'd, so a
// busy colliding sibling session in the shared encoded dir cannot mask staleness.
//
// `escalated` is terminal (short-circuited). `nudged` is a HOLD state entered by
// the automatic path's poke (recovery.js's pokeOrEscalate — never a kill): while
// nudgeWindowMs hasn't elapsed since nudgedAt, stay `nudged` unless the outbound
// signal has advanced past nudgedAt (the poke worked -> clear to `alive`); once
// the window elapses with no advance, stop holding and fall through to a fresh
// recompute so pokeOrEscalate can decide (another poke, or escalate). Verdict
// status enum: alive | stale | nudged | ambiguous | escalated.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { projectDirFor } = require('./target-session.js');

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_NUDGE_WINDOW_MS = 3 * 60 * 1000; // how long a poke stays "in effect" before falling through
const GIT_TIMEOUT_MS = 4000;

// isSafeId(id) -> bool. A descriptor id must be a single safe path segment before
// it is ever path.join'd into locks/liveness/recovery paths (P1-7): no separators,
// no traversal, no control chars/whitespace, not empty, not '.'/'..'.
function isSafeId(id) {
  if (typeof id !== 'string' || id === '') return false;
  if (id === '.' || id === '..') return false;
  if (id.includes('..')) return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

function devswarmRoot(home) {
  return path.join(home || os.homedir(), '.anti-hall', 'devswarm');
}
function livenessPathFor(id, home) {
  if (!isSafeId(id)) throw new Error('unsafe workspace id: ' + JSON.stringify(id));
  return path.join(devswarmRoot(home), 'liveness', String(id) + '.json');
}

// transcriptMtime(projectDir, sessionId, fsi) -> ms | null. uuid-SCOPED: stats
// ONLY the target session's own <sessionId>.jsonl (P1-6). A colliding sibling's
// fresh transcript in the same dir must NOT mask this session's staleness.
function transcriptMtime(projectDir, sessionId, fsi) {
  const F = fsi || fs;
  if (!sessionId) return null;
  try {
    return F.statSync(path.join(projectDir, sessionId + '.jsonl')).mtimeMs;
  } catch (_) {
    return null;
  }
}

// worktreeActivityMtime(worktreePath, runners) -> ms | null. The git-commit time
// (git log -1 --format=%ct, seconds->ms), or null (UNKNOWN) when there is no
// reliable git signal — no commits yet (plausible right when a task starts) or git
// unavailable / detached .git. It NEVER falls back to a worktree DIRECTORY mtime
// (P1-15): editing a file NESTED under the worktree does NOT bump the dir mtime, so
// a dir-mtime reading is near-permanently 'idle' and would collapse the two-signal
// anti-false-positive safeguard to transcript-only. A null activity signal makes
// computeLiveness treat the workspace as NOT conclusively stale (fail-safe toward
// alive), which is the correct direction — better to miss a wedge than to
// manufacture a false idle reading and wrong-kill.
function worktreeActivityMtime(worktreePath, runners) {
  const R = runners || {};
  try {
    const ct = R.gitCommitTs ? R.gitCommitTs(worktreePath) : defaultGitCommitTs(worktreePath);
    if (Number.isFinite(ct) && ct > 0) return ct;
  } catch (_) {}
  return null; // no reliable git activity signal -> UNKNOWN (never a dir-mtime fallback)
}

function defaultGitCommitTs(worktreePath) {
  const r = spawnSync('git', ['-C', worktreePath, 'log', '-1', '--format=%ct'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status !== 0 || r.signal) return null; // r.signal set when killed on timeout
  const secs = parseInt(String(r.stdout || '').trim(), 10);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

// unreadBacklog(inboxPath, cursorPath, fsi) -> { lines: string[], known: boolean }.
// inboxPath = NDJSON append-only (one message/line). cursorPath = a bare integer
// OR JSON {line:<int>} = count of consumed lines. Unparseable/absent cursor =>
// known:false (treated as NOT pending — fail-safe: never nominate an unreadable
// workspace for a kill).
function unreadBacklog(inboxPath, cursorPath, fsi) {
  const F = fsi || fs;
  let all;
  try {
    all = String(F.readFileSync(inboxPath, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  } catch (_) {
    return { lines: [], known: false };
  }
  let cursor;
  try {
    const raw = String(F.readFileSync(cursorPath, 'utf8')).trim();
    if (/^\d+$/.test(raw)) cursor = parseInt(raw, 10);
    else cursor = Number(JSON.parse(raw).line);
  } catch (_) {
    return { lines: [], known: false };
  }
  if (!Number.isFinite(cursor) || cursor < 0) return { lines: [], known: false };
  return { lines: all.slice(cursor), known: true };
}

// computeLiveness(opts) ->
//   { status, lastOutboundTs, staleSince, nudgeAttempts, nudgedAt, pending }.
function computeLiveness(opts) {
  const descriptor = opts.descriptor;
  const now = opts.now || Date.now();
  const idle = Number.isFinite(opts.idleThresholdMs) ? opts.idleThresholdMs : DEFAULT_IDLE_MS;
  const nudgeWindowMs = Number.isFinite(opts.nudgeWindowMs) ? opts.nudgeWindowMs : DEFAULT_NUDGE_WINDOW_MS;
  const home = opts.home || os.homedir();
  const runners = opts.runners || {};
  const fsi = runners.fs || fs;

  // Prior verdict (persisted across sweeps) — read FIRST so the terminal + nudge
  // short-circuits can skip all recomputation.
  let prev = null;
  try { prev = JSON.parse(fsi.readFileSync(livenessPathFor(descriptor.id, home), 'utf8')); } catch (_) {}
  const nudgeAttempts = (prev && Number.isFinite(prev.nudgeAttempts)) ? prev.nudgeAttempts : 0;
  const nudgedAt = (prev && Number.isFinite(prev.nudgedAt)) ? prev.nudgedAt : null;
  const priorStaleSince = (prev && Number.isFinite(prev.staleSince)) ? prev.staleSince : null;
  const priorOutbound = (prev && Number.isFinite(prev.lastOutboundTs)) ? prev.lastOutboundTs : null;

  // P2-13 TERMINAL short-circuit: `escalated` is sticky — return it unchanged,
  // never re-stat, so the sweep stops re-targeting a workspace a human must handle.
  if (prev && prev.status === 'escalated') {
    return { status: 'escalated', lastOutboundTs: priorOutbound, staleSince: priorStaleSince, nudgeAttempts, nudgedAt, pending: false };
  }

  const projectDir = projectDirFor(descriptor.worktreePath, home);
  const tMtime = transcriptMtime(projectDir, descriptor.sessionId, fsi);
  const wMtime = worktreeActivityMtime(descriptor.worktreePath, runners);
  const lastOutboundTs = Math.max(tMtime || 0, wMtime || 0) || null;

  const backlog = unreadBacklog(descriptor.inboxPath, descriptor.cursorPath, fsi);
  const pending = backlog.known && backlog.lines.length > 0;

  // NUDGE hold: a poke is outstanding. Stay `nudged` unless the fresh outbound
  // signal has advanced past nudgedAt (proof the poke woke the session up ->
  // clear to alive). Once nudgeWindowMs elapses with no advance, stop holding —
  // fall through to the normal recompute below so pokeOrEscalate (called by the
  // sweep on a `stale` verdict) can decide: another poke, or escalate once the
  // attempt budget is exhausted. NEVER a kill from this branch.
  if (prev && prev.status === 'nudged') {
    const advanced = nudgedAt !== null && lastOutboundTs !== null && lastOutboundTs > nudgedAt;
    if (advanced) {
      return { status: 'alive', lastOutboundTs, staleSince: null, nudgeAttempts, nudgedAt, pending };
    }
    const withinWindow = nudgedAt !== null && (now - nudgedAt) < nudgeWindowMs;
    if (withinWindow) {
      return { status: 'nudged', lastOutboundTs: priorOutbound, staleSince: priorStaleSince, nudgeAttempts, nudgedAt, pending };
    }
    // window elapsed, no advance -> fall through to the normal recompute.
  }

  // BOTH signals must be present AND idle. A missing signal -> not conclusively
  // stale (fail-safe). max() being idle is equivalent to "both idle".
  const haveBoth = tMtime !== null && wMtime !== null;
  const bothIdle = haveBoth && (now - tMtime) > idle && (now - wMtime) > idle;
  const stale = bothIdle && pending;

  return {
    status: stale ? 'stale' : 'alive',
    lastOutboundTs,
    staleSince: stale ? (priorStaleSince || now) : null,
    nudgeAttempts,
    nudgedAt,
    pending,
  };
}

// writeVerdict(id, verdict, home, fsi) — atomic tmp+rename write.
function writeVerdict(id, verdict, home, fsi) {
  const F = fsi || fs;
  const p = livenessPathFor(id, home); // throws on an unsafe id (caller fails open)
  F.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  F.writeFileSync(tmp, JSON.stringify(verdict));
  F.renameSync(tmp, p);
  return p;
}

module.exports = {
  DEFAULT_IDLE_MS, DEFAULT_COOLDOWN_MS, DEFAULT_NUDGE_WINDOW_MS, isSafeId, devswarmRoot, livenessPathFor, projectDirFor,
  transcriptMtime, worktreeActivityMtime, unreadBacklog, computeLiveness, writeVerdict,
};
