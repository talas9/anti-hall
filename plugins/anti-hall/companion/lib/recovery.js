'use strict';
// anti-hall :: recovery — kill the ONE confirmed wedged `claude` pid (and its
// process group) and resume it headless from the same worktree cwd, feeding the
// unread backlog as the fresh prompt. Workaround for claude-code#39755.
//
// SAFETY INVARIANTS (each proven by a test):
//   - NEVER kill on an ambiguous target (0 or >1 candidates) — escalate instead.
//   - TOCTOU re-confirm: re-derive identity on FRESH data immediately before
//     SIGTERM AND again before SIGKILL; if the pid no longer maps to the same
//     uuid+worktree+sessionId, ABSTAIN (a pid recycled in the grace window is
//     never SIGKILLed — mirrors mcp-reaper.js:282-294).
//   - Precise kill of the single confirmed pid, PLUS its process GROUP (POSIX
//     negative-pid) so the wedged child's MCP grandchildren are cleaned up rather
//     than reparented to PID 1. No broad pkill, no pattern.
//   - Single-writer per workspace (atomic O_EXCL lockfile) — never resume one
//     session id from two processes concurrently. A DEAD holder (or a lock past
//     LOCK_STALE_MS) is stolen so a supervisor crash cannot permanently disable
//     recovery (mirrors swarm-guard.js:150-215); a live, fresh holder is respected.
//   - Windows: escalate-only, never kill (cwd confirm-gate is unavailable there).
//   - Cap at N recoveries -> escalate, no restart loops.
//   - DETACHED resume: unref'd, no 120s SIGTERM timeout (never kills real agentic
//     work). A timed-out/unconfirmed resume is recorded 'recovering' (+recoveredAt),
//     NEVER falsely 'alive'.
//   - "No conversation found" is an EXPECTED, handled failure (log + escalate).
//   - Any internal error -> logged + { action:'error' }, never throws, never kills.
//
// All kill/spawn/lock/fs/reconfirm access is injectable so tests touch NO real
// process.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { devswarmRoot, livenessPathFor, writeVerdict, unreadBacklog, isSafeId } = require('./liveness.js');
const { verifyTarget } = require('./target-session.js');

const DEFAULT_MAX_RECOVERIES = 3;
const DEFAULT_GRACE_MS = 5000;
const LOCK_STALE_MS = 15 * 60 * 1000; // TTL backstop; the dead-holder probe is the primary steal signal
const RESUME_READINESS_MS = 4000;     // how long to watch a fresh resume for an immediate error — NEVER a kill deadline

function lockPathFor(id, home) {
  if (!isSafeId(id)) throw new Error('unsafe workspace id: ' + JSON.stringify(id));
  return path.join(devswarmRoot(home), 'locks', String(id) + '.lock');
}
function recoveryLogPath(home) {
  return path.join(devswarmRoot(home), 'recovery.log');
}

function appendLog(home, obj, fsi) {
  const F = fsi || fs;
  try {
    const p = recoveryLogPath(home);
    F.mkdirSync(path.dirname(p), { recursive: true });
    F.appendFileSync(p, JSON.stringify(Object.assign({ ts: Date.now() }, obj)) + '\n');
  } catch (_) {}
}

// defaultIsAlive(pid) -> bool. process.kill(pid,0) throws ESRCH when the pid is
// gone; EPERM means it exists but we may not signal it (still "alive").
function defaultIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

// acquireLock(id, home, io) -> release() | null. Atomic O_EXCL create carrying the
// holder {pid, ts, token}. On EEXIST it STEALS iff the holder pid is dead OR the
// lock is older than LOCK_STALE_MS (mirrors swarm-guard's stale-steal); otherwise
// a live, fresh holder is respected -> null (caller aborts rather than double-
// resume). Release unlinks ONLY when the on-disk token is still ours.
function acquireLock(id, home, io) {
  const F = (io && io.fs) || fs;
  const isAlive = (io && io.isAlive) || defaultIsAlive;
  const now = (io && io.now) || Date.now;
  const p = lockPathFor(id, home);
  try { F.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
  for (let attempt = 0; attempt < 2; attempt++) {
    const ts = now();
    const token = process.pid + ':' + ts + ':' + Math.random().toString(36).slice(2);
    try {
      const fd = F.openSync(p, 'wx');
      try { F.writeSync(fd, JSON.stringify({ pid: process.pid, ts, token })); } finally { F.closeSync(fd); }
      return function release() {
        try {
          const cur = JSON.parse(F.readFileSync(p, 'utf8'));
          if (cur && cur.token === token) F.unlinkSync(p);
        } catch (_) { /* not ours / unreadable -> leave it; a later stale-steal reclaims it */ }
      };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null; // any other error -> fail-open (no lock)
      let holder = null;
      try { holder = JSON.parse(F.readFileSync(p, 'utf8')); } catch (_) {}
      const holderPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
      const holderTs = holder && Number.isFinite(holder.ts) ? holder.ts : null;
      const dead = holderPid !== null && !isAlive(holderPid);
      const stale = holderTs === null || (now() - holderTs) > LOCK_STALE_MS;
      if (dead || stale) {
        try { F.unlinkSync(p); } catch (_) {}
        continue; // retry the O_EXCL create
      }
      return null; // live, fresh holder -> respected
    }
  }
  return null;
}

function readRecoveries(id, home, F) {
  try { return JSON.parse(F.readFileSync(livenessPathFor(id, home), 'utf8')).recoveries || 0; } catch (_) { return 0; }
}

// persist a verdict, carrying forward lastOutboundTs/staleSince/recoveredAt from
// any prior one (unless overridden via extra).
function persistVerdict(descriptor, home, F, status, extra) {
  let recoveries = 0, staleSince = null, lastOutboundTs = null, recoveredAt = null;
  try {
    const prev = JSON.parse(F.readFileSync(livenessPathFor(descriptor.id, home), 'utf8'));
    if (prev) {
      recoveries = prev.recoveries || 0;
      staleSince = prev.staleSince != null ? prev.staleSince : null;
      lastOutboundTs = prev.lastOutboundTs != null ? prev.lastOutboundTs : null;
      recoveredAt = Number.isFinite(prev.recoveredAt) ? prev.recoveredAt : null;
    }
  } catch (_) {}
  const v = Object.assign({ status, lastOutboundTs, staleSince, recoveries, recoveredAt }, extra || {});
  try { writeVerdict(descriptor.id, v, home, F); } catch (_) {}
  return v;
}

function sleepSync(ms) {
  try { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, Math.max(0, ms | 0)); } catch (_) {}
}
function defaultKill(pid, signal) {
  try { process.kill(pid, signal); return true; } catch (_) { return false; }
}
// defaultKillGroup — signal the whole POSIX process group (negative pid) so the
// target's children (MCP servers) are cleaned up with it. Best-effort; a missing
// group just means no extra recipients. Never reached on win32 (escalate-only).
function defaultKillGroup(pid, signal) {
  try { process.kill(-Math.abs(pid), signal); return true; } catch (_) { return false; }
}

// defaultReconfirm(target, descriptor, selfPid) -> bool. Fresh re-derivation via
// verifyTarget using the real ps/lsof runners (a hung probe is bounded inside the
// runner). Returns true iff the SAME pid+uuid is still the sole confirmed target.
function defaultReconfirm(target, descriptor, selfPid) {
  return verifyTarget({
    worktreePath: descriptor.worktreePath,
    sessionId: descriptor.sessionId,
    pid: target.pid,
    uuid: target.uuid,
    selfPid,
  });
}

// defaultSpawnResume(a) -> { pid, earlyExit, timedOut, output }. DETACHED + unref'd
// so the resumed session runs independently. NO kill-on-timeout: the bounded
// readiness poll only watches for an immediate early exit (which surfaces
// "No conversation found"); if the child is still running when the window elapses
// that is SUCCESS-in-progress, NOT a reason to kill it.
function defaultSpawnResume(a) {
  const readinessMs = Number.isFinite(a.readinessMs) ? a.readinessMs : RESUME_READINESS_MS;
  let outFile = null, fd = 'ignore';
  try {
    outFile = path.join(os.tmpdir(), 'antihall-resume-' + process.pid + '-' + Date.now() + '.log');
    fd = fs.openSync(outFile, 'a');
  } catch (_) { fd = 'ignore'; outFile = null; }
  const child = spawn('claude', ['-p', '--resume', a.uuid, '--dangerously-skip-permissions'], {
    cwd: a.cwd, detached: true, stdio: ['pipe', fd, fd],
  });
  try { child.stdin.write(a.prompt || ''); child.stdin.end(); } catch (_) {}
  const pid = child.pid;
  child.unref();

  const deadline = Date.now() + readinessMs;
  let earlyExit = false;
  while (Date.now() < deadline) {
    if (!defaultIsAlive(pid)) { earlyExit = true; break; }
    sleepSync(100);
  }
  let output = '';
  if (outFile) { try { output = fs.readFileSync(outFile, 'utf8'); } catch (_) {} }
  // Only clean up the temp file once the child is gone; while it is alive it may
  // still be writing to fd (leave it — the short-lived sweep process will exit and
  // the OS reclaims the descriptor).
  if (earlyExit) {
    try { if (typeof fd === 'number') fs.closeSync(fd); } catch (_) {}
    if (outFile) { try { fs.unlinkSync(outFile); } catch (_) {} }
  }
  return { pid, earlyExit, timedOut: !earlyExit, output };
}

// recover(opts) -> { action, ... }. See header for invariants.
function recover(opts) {
  const descriptor = opts.descriptor;
  const home = opts.home || os.homedir();
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const io = opts.io || {};
  const F = io.fs || fs;
  const platform = io.platform || process.platform;
  const selfPid = Number.isFinite(io.selfPid) ? io.selfPid : process.pid;
  const maxRec = Number.isFinite(opts.maxRecoveries) ? opts.maxRecoveries : DEFAULT_MAX_RECOVERIES;
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : DEFAULT_GRACE_MS;
  const target = opts.target;
  const reconfirm = io.reconfirm || ((t) => defaultReconfirm(t, descriptor, selfPid));

  try {
    // Confirm-gate: never kill on an ambiguous target.
    if (!target || target.ambiguous || !target.pid) {
      appendLog(home, { id: descriptor.id, action: 'abstain', reason: (target && target.reason) || 'no-target' }, F);
      persistVerdict(descriptor, home, F, 'ambiguous');
      return { action: 'abstain', reason: (target && target.reason) || 'no-target' };
    }

    // Windows: escalate-only, never kill.
    if (platform === 'win32') {
      appendLog(home, { id: descriptor.id, action: 'escalate', reason: 'win32-no-kill' }, F);
      persistVerdict(descriptor, home, F, 'escalated');
      return { action: 'escalate', reason: 'win32-no-kill' };
    }

    // Cap: stop auto-recovering after N.
    const recoveries = readRecoveries(descriptor.id, home, F);
    if (recoveries >= maxRec) {
      appendLog(home, { id: descriptor.id, action: 'escalate', reason: 'max-recoveries', recoveries }, F);
      persistVerdict(descriptor, home, F, 'escalated');
      return { action: 'escalate', reason: 'max-recoveries', recoveries };
    }

    // Single-writer lock (never resume the same id from two processes at once).
    const lock = io.lock ? io.lock(descriptor.id, home) : acquireLock(descriptor.id, home, { fs: F, isAlive: io.isAlive });
    if (!lock) {
      appendLog(home, { id: descriptor.id, action: 'skip', reason: 'locked' }, F);
      return { action: 'skip', reason: 'locked' };
    }

    try {
      persistVerdict(descriptor, home, F, 'recovering');
      const kill = io.kill || defaultKill;
      const killGroup = io.killGroup || defaultKillGroup;

      // TOCTOU re-confirm #1 — immediately before SIGTERM, on FRESH data.
      if (!reconfirm(target)) {
        appendLog(home, { id: descriptor.id, action: 'abstain', reason: 'identity-changed-pre-term', pid: target.pid }, F);
        persistVerdict(descriptor, home, F, 'ambiguous');
        return { action: 'abstain', reason: 'identity-changed' };
      }

      // Precise kill: SIGTERM the ONE pid + its group, then SIGKILL only if it
      // survives grace AND still re-confirms as the same target.
      kill(target.pid, 'SIGTERM');
      killGroup(target.pid, 'SIGTERM');
      appendLog(home, { id: descriptor.id, action: 'sigterm', pid: target.pid, uuid: target.uuid }, F);
      (io.sleep || sleepSync)(graceMs);
      if (kill(target.pid, 0)) {
        // TOCTOU re-confirm #2 — before SIGKILL. A pid recycled during the grace
        // window must NOT be SIGKILLed.
        if (!reconfirm(target)) {
          appendLog(home, { id: descriptor.id, action: 'abstain', reason: 'identity-changed-pre-kill', pid: target.pid }, F);
          persistVerdict(descriptor, home, F, 'ambiguous');
          return { action: 'abstain', reason: 'identity-changed' };
        }
        kill(target.pid, 'SIGKILL');
        killGroup(target.pid, 'SIGKILL');
        appendLog(home, { id: descriptor.id, action: 'sigkill', pid: target.pid }, F);
      }

      // Resume headless (DETACHED) from the same cwd; feed the unread backlog.
      const backlog = unreadBacklog(descriptor.inboxPath, descriptor.cursorPath, F);
      const prompt = backlog.lines.join('\n');
      const res = (io.spawnResume || defaultSpawnResume)({ uuid: target.uuid, cwd: descriptor.worktreePath, prompt });
      const combined = String((res && res.output) || '') + String((res && res.stdout) || '') + String((res && res.stderr) || '');

      if (/No conversation found/i.test(combined)) {
        appendLog(home, { id: descriptor.id, action: 'escalate', reason: 'no-conversation-found', uuid: target.uuid }, F);
        persistVerdict(descriptor, home, F, 'escalated');
        return { action: 'escalate', reason: 'no-conversation-found' };
      }

      // Resume launched. It runs INDEPENDENTLY — its true liveness is unknown until
      // the next post-cooldown sweep, so record 'recovering' (+recoveredAt) and
      // increment the counter. NEVER a false 'alive' from an unconfirmed resume.
      const v = persistVerdict(descriptor, home, F, 'recovering', { recoveries: recoveries + 1, recoveredAt: now });
      appendLog(home, { id: descriptor.id, action: 'resumed', pid: target.pid, uuid: target.uuid, recoveries: v.recoveries }, F);
      return { action: 'resumed', recoveries: v.recoveries, uuid: target.uuid, pid: target.pid };
    } finally {
      lock();
    }
  } catch (e) {
    appendLog(home, { id: descriptor && descriptor.id, action: 'error', reason: String(e && e.message) }, F);
    return { action: 'error', reason: String(e && e.message) };
  }
}

module.exports = {
  DEFAULT_MAX_RECOVERIES, DEFAULT_GRACE_MS, LOCK_STALE_MS,
  lockPathFor, recoveryLogPath, acquireLock, recover,
};
