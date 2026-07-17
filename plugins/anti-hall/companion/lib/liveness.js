'use strict';
// anti-hall :: liveness — outbound-staleness detector + atomic verdict writer.
// Workaround for claude-code#39755.
//
// STALE only when BOTH outbound signals (the target session's OWN transcript
// mtime AND git/worktree activity) are PRESENT and each idle past the threshold,
// AND the workspace has a pending unread backlog past its cursor. A workspace idle
// because it has nothing to do is NOT stale. Fail direction = NOT stale (never
// nominate a healthy workspace for a kill). Liveness is uuid-SCOPED: only
// <sessionId>.jsonl is stat'd, so a busy colliding sibling session in the shared
// encoded dir cannot mask staleness.
//
// HEARTBEAT = definitive proof-of-life (v0.62, owner-approved — supersedes the
// prior "inbound heartbeat deliberately NOT used" guard). A heartbeat is emitted
// ONLY by the workspace's OWN live session (scripts/devswarm.js cmdHeartbeat
// writes heartbeats/<id>.json); an archived/frozen/dead env emits NOTHING, so a
// FRESH heartbeat (within heartbeatFreshMs) is definitive proof the env is ALIVE.
// The two axes are DECOUPLED: "env alive" (a heartbeat proves it) vs "agent making
// progress" (the outbound-idle + backlog signal below). A fresh heartbeat CLEARS
// the stale/nudged/escalated verdict for coordination + archive purposes and
// short-circuits BEFORE any recompute (see computeLiveness). No-progress detection
// remains a SEPARATE, non-archiving signal — it is expressed ONLY as the `stale`
// verdict here and NEVER fires while a fresh heartbeat is present, so a heartbeating
// workspace can never be force-archived or nudged-as-gone. The old fear (a wedged
// agent emits heartbeats without real work) is handled by keeping no-progress a
// distinct, advisory signal, not by ignoring the heartbeat's liveness proof.
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
// DEFAULT_HEARTBEAT_FRESH_MS — how recently a heartbeat must have been recorded to
// count as PROOF the env is alive. Matched to DEFAULT_IDLE_MS (15 min) so the
// "fresh heartbeat" window aligns with the same idle horizon the staleness detector
// uses: a session that heartbeats at least once per idle window is provably alive.
const DEFAULT_HEARTBEAT_FRESH_MS = DEFAULT_IDLE_MS;
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
// heartbeatPathFor(id, home) — the durable heartbeat file scripts/devswarm.js
// cmdHeartbeat writes (heartbeats/<id>.json). SAME id-safety gate as
// livenessPathFor (never path.join an unsafe id).
function heartbeatPathFor(id, home) {
  if (!isSafeId(id)) throw new Error('unsafe workspace id: ' + JSON.stringify(id));
  return path.join(devswarmRoot(home), 'heartbeats', String(id) + '.json');
}
// heartbeatTs(id, home, fsi) -> ms | null. The recorded `ts` from
// heartbeats/<id>.json (cmdHeartbeat writes `ts: now`), falling back to the
// file's mtime if the JSON is torn/missing the field. null when absent /
// unreadable / unsafe id. Pure fs, never throws.
function heartbeatTs(id, home, fsi) {
  const F = fsi || fs;
  let p;
  try { p = heartbeatPathFor(id, home); } catch (_) { return null; }
  try {
    const beat = JSON.parse(F.readFileSync(p, 'utf8'));
    if (beat && Number.isFinite(beat.ts)) return beat.ts;
  } catch (_) { /* torn/absent JSON -> fall back to mtime */ }
  try { return F.statSync(p).mtimeMs; } catch (_) { return null; }
}
// isFreshBeat(ts, now, freshMs) -> bool. The ONE freshness rule, shared by
// hasFreshHeartbeat and computeLiveness's heartbeat short-circuit so both agree.
// P1-7: require `0 < ts <= now` BEFORE applying the window — a FUTURE ts (clock
// skew, a forged/typo'd beat) makes `now - ts` NEGATIVE, which trivially passes
// `<= freshMs` and would mark the workspace "provably alive" until that future
// time, indefinitely suppressing the stale gate + reaper. A future or non-positive
// ts is NOT fresh (treated as no proof-of-life at all).
function isFreshBeat(ts, now, freshMs) {
  if (ts === null || !Number.isFinite(ts) || ts <= 0) return false;
  if (ts > now) return false; // future ts is not proof of present life
  return (now - ts) <= freshMs;
}

// hasFreshHeartbeat(id, home, opts) -> bool. True iff a heartbeat for `id` was
// recorded within `freshMs` of `now`. Definitive proof-of-life: a heartbeat is
// emitted ONLY by the workspace's own live session, so a fresh one means the env
// is ALIVE (see the header's HEARTBEAT decouple note). opts: { now, freshMs, fs }.
function hasFreshHeartbeat(id, home, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const freshMs = Number.isFinite(o.freshMs) ? o.freshMs : DEFAULT_HEARTBEAT_FRESH_MS;
  const ts = heartbeatTs(id, home, o.fs);
  return isFreshBeat(ts, now, freshMs);
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
  const heartbeatFreshMs = Number.isFinite(opts.heartbeatFreshMs) ? opts.heartbeatFreshMs : DEFAULT_HEARTBEAT_FRESH_MS;
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

  // HEARTBEAT proof-of-life short-circuit (v0.62 decouple — see header). A FRESH
  // heartbeat is definitive proof the env is ALIVE, so it CLEARS the verdict to
  // `alive` and resets the nudge/stale state — even a sticky `escalated`, because a
  // heartbeating env is by definition not the abandoned/wedged case escalation
  // exists for. This is checked BEFORE the escalated short-circuit so a heartbeat
  // that arrives after escalation still recovers the workspace. lastOutboundTs is
  // set to the heartbeat ts (the session's own emission IS outbound activity), so
  // no git spawn is needed on this path. `pending` is the cheap fs backlog read
  // (no git) — a heartbeating workspace with real unread is still alive, and the
  // unread is surfaced (coordination axis) without ever being nudged-as-gone.
  const beatTs = heartbeatTs(descriptor.id, home, fsi);
  if (isFreshBeat(beatTs, now, heartbeatFreshMs)) { // P1-7: a future/non-positive ts is NOT fresh
    const hbBacklog = unreadBacklog(descriptor.inboxPath, descriptor.cursorPath, fsi);
    return {
      status: 'alive',
      lastOutboundTs: Math.max(beatTs, priorOutbound || 0) || beatTs,
      staleSince: null,
      nudgeAttempts: 0,
      nudgedAt: null,
      pending: hbBacklog.known && hbBacklog.lines.length > 0,
    };
  }

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
  DEFAULT_IDLE_MS, DEFAULT_COOLDOWN_MS, DEFAULT_NUDGE_WINDOW_MS, DEFAULT_HEARTBEAT_FRESH_MS,
  isSafeId, devswarmRoot, livenessPathFor, heartbeatPathFor, projectDirFor,
  transcriptMtime, worktreeActivityMtime, unreadBacklog, computeLiveness, writeVerdict,
  heartbeatTs, hasFreshHeartbeat, isFreshBeat,
};
