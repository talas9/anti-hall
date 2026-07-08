'use strict';
// anti-hall :: devswarm-supervisor — one sweep over published workspace
// descriptors: compute liveness, write the verdict, poke or escalate the stale
// ones. Workaround for claude-code#39755. OPT-IN (installed explicitly by the
// user via install-devswarm-supervisor.js), fail-open per workspace, pure Node.
//
// This automatic path NEVER kills and NEVER resolves a pid — it does not import
// findTarget or recover. On a `stale` verdict it only pokes (an optional
// descriptor-supplied nudgeCommand) or escalates (a log line + optional
// escalateCommand); see lib/recovery.js's pokeOrEscalate. Kill+resume survives
// ONLY as the on-demand devswarm-recover.js CLI, invoked explicitly per
// workspace — never from this sweep.
//
// Activation signal = the presence of ~/.anti-hall/devswarm/workspaces/*.json
// descriptors (published by the consumer). DEVSWARM_REPO_ID is a per-SESSION var
// and is absent in a launchd/systemd background job, so it is intentionally NOT
// required here; the daemon gate is only the off / hard-kill switches.
//
// SINGLE-FLIGHT (P2-11): a cron fallback does NOT coalesce ticks the way launchd
// StartInterval / systemd OnUnitActiveSec do, so main() takes a process-wide sweep
// lock (dead-holder/stale steal) and exits immediately if a prior sweep is still
// running — overlapping sweeps must never stack blocking ps/lsof work.
//
// ENV-TUNABLE THRESHOLDS (all seconds; absent/invalid -> module default, clamped):
//   ANTIHALL_DEVSWARM_IDLE_SEC            idleThresholdMs   (default 900, min 60)
//   ANTIHALL_DEVSWARM_COOLDOWN_SEC        cooldownMs        (default 600, min 0)
//   ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS  nudgeMaxAttempts  (default 2,   1..20)
//   ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC    nudgeWindowMs     (default 180, min 1)
//   ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC  nudgeCooldownMs   (default 120, min 0)
// See resolveThresholdsFromEnv() below; main() reads through it so a real
// launchd/systemd/cron sweep honors overrides. (The on-demand devswarm-recover.js
// CLI resolves its OWN maxRecoveries/graceMs directly, decoupled from this sweep.)

const os = require('os');
const fs = require('fs');
const path = require('path');
const {
  devswarmRoot, computeLiveness, writeVerdict, isSafeId,
  DEFAULT_IDLE_MS, DEFAULT_COOLDOWN_MS, DEFAULT_NUDGE_WINDOW_MS,
} = require('./lib/liveness.js');
const { pokeOrEscalate, DEFAULT_NUDGE_MAX_ATTEMPTS, DEFAULT_NUDGE_COOLDOWN_MS } = require('./lib/recovery.js');

const SWEEP_LOCK_STALE_MS = 5 * 60 * 1000; // a sweep should never run this long; steal a lock older than this

// ----- env-tunable thresholds (P2-xx) -----
// parseEnvNum(env, name, defaultVal, {min,max}) -> number. A launchd/systemd/cron
// sweep has no way to pass CLI flags, so these thresholds are env-only. Absent /
// non-numeric / non-positive input ALWAYS falls back to defaultVal (fail-open —
// a typo in a plist/unit file must never crash the sweep or silently zero a
// threshold). min/max are applied to whichever value wins (env or default) so a
// clamp can never be bypassed by simply omitting the var.
function parseEnvNum(env, name, defaultVal, opts) {
  const o = opts || {};
  const raw = (env || {})[name];
  let v = defaultVal;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = parseInt(raw.trim(), 10);
    if (Number.isFinite(n) && n > 0) v = n;
  }
  if (Number.isFinite(o.min)) v = Math.max(o.min, v);
  if (Number.isFinite(o.max)) v = Math.min(o.max, v);
  return v;
}

// resolveThresholdsFromEnv(env) -> { idleThresholdMs, cooldownMs, nudgeMaxAttempts,
// nudgeWindowMs, nudgeCooldownMs }. All *_SEC env vars are seconds; converted to
// ms here so callers (sweepOnce, computeLiveness, pokeOrEscalate) keep taking ms
// as they already do.
function resolveThresholdsFromEnv(env) {
  const e = env || process.env;
  const idleSec = parseEnvNum(e, 'ANTIHALL_DEVSWARM_IDLE_SEC', DEFAULT_IDLE_MS / 1000, { min: 60 });
  const cooldownSec = parseEnvNum(e, 'ANTIHALL_DEVSWARM_COOLDOWN_SEC', DEFAULT_COOLDOWN_MS / 1000, { min: 0 });
  const nudgeMaxAttempts = parseEnvNum(e, 'ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS', DEFAULT_NUDGE_MAX_ATTEMPTS, { min: 1, max: 20 });
  const nudgeWindowSec = parseEnvNum(e, 'ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC', DEFAULT_NUDGE_WINDOW_MS / 1000, { min: 1 });
  const nudgeCooldownSec = parseEnvNum(e, 'ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC', DEFAULT_NUDGE_COOLDOWN_MS / 1000, { min: 0 });
  return {
    idleThresholdMs: idleSec * 1000,
    cooldownMs: cooldownSec * 1000,
    nudgeMaxAttempts,
    nudgeWindowMs: nudgeWindowSec * 1000,
    nudgeCooldownMs: nudgeCooldownSec * 1000,
  };
}

function workspacesDir(home) {
  return path.join(devswarmRoot(home), 'workspaces');
}

// readDescriptors(home, fsi) -> [{id, worktreePath, inboxPath, cursorPath, sessionId}].
// Skips unreadable/malformed files (fail-open: one bad descriptor never stops the
// sweep). Requires id + worktreePath + sessionId, AND a path-safe id (P1-7) so a
// hostile id can never escape into locks/liveness/recovery paths.
function readDescriptors(home, fsi) {
  const F = fsi || fs;
  let names = [];
  try { names = F.readdirSync(workspacesDir(home)); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    try {
      const d = JSON.parse(F.readFileSync(path.join(workspacesDir(home), n), 'utf8'));
      if (d && d.worktreePath && d.sessionId && isSafeId(d.id)) out.push(d);
    } catch (_) {}
  }
  return out;
}

// supervisorEnabled(env) — daemon gate: off / hard-kill only.
function supervisorEnabled(env) {
  const e = env || process.env;
  if (e.DISABLE_ANTIHALL_DEVSWARM === '1') return false;
  if (String(e.ANTIHALL_DEVSWARM_SUPERVISOR || 'auto').trim().toLowerCase() === 'off') return false;
  return true;
}

// ----- single-flight sweep lock (P2-11) -----
function sweepLockPath(home) { return path.join(devswarmRoot(home), 'locks', 'sweep.lock'); }
function isAliveDefault(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
// acquireSweepLock(home, io) -> release() | null. Same dead-holder/stale-steal
// semantics as the per-workspace lock, on a fixed process-wide path.
function acquireSweepLock(home, io) {
  const F = (io && io.fs) || fs;
  const isAlive = (io && io.isAlive) || isAliveDefault;
  const now = (io && io.now) || Date.now;
  const p = sweepLockPath(home);
  try { F.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
  for (let attempt = 0; attempt < 2; attempt++) {
    const ts = now();
    const token = process.pid + ':' + ts + ':' + Math.random().toString(36).slice(2);
    try {
      const fd = F.openSync(p, 'wx');
      try { F.writeSync(fd, JSON.stringify({ pid: process.pid, ts, token })); } finally { F.closeSync(fd); }
      return function release() {
        try { const cur = JSON.parse(F.readFileSync(p, 'utf8')); if (cur && cur.token === token) F.unlinkSync(p); } catch (_) {}
      };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
      let holder = null;
      try { holder = JSON.parse(F.readFileSync(p, 'utf8')); } catch (_) {}
      const holderPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
      const holderTs = holder && Number.isFinite(holder.ts) ? holder.ts : null;
      const dead = holderPid !== null && !isAlive(holderPid);
      const stale = holderTs === null || (now() - holderTs) > SWEEP_LOCK_STALE_MS;
      if (dead || stale) { try { F.unlinkSync(p); } catch (_) {} continue; }
      return null; // live, fresh sweep in progress -> skip this tick
    }
  }
  return null;
}

// sweepOnce({home, now, env, idleThresholdMs, cooldownMs, nudgeWindowMs,
//   nudgeMaxAttempts, nudgeCooldownMs, deps}) -> [{ id, verdict, poke } | { id,
//   error }]. deps injectable for tests. NEVER resolves a pid, NEVER kills — a
//   `stale` verdict only ever reaches pokeOrEscalate (poke or escalate; see
//   lib/recovery.js). The on-demand devswarm-recover.js CLI is the only caller
//   that ever resolves a target / kills.
function sweepOnce(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const deps = o.deps || {};
  const F = deps.fs || fs;
  if (!supervisorEnabled(env)) return [];

  const descriptors = (deps.readDescriptors || readDescriptors)(home, F);
  const results = [];
  for (const d of descriptors) {
    try {
      const verdict = (deps.computeLiveness || computeLiveness)({
        descriptor: d, now: o.now, home, runners: deps.runners,
        idleThresholdMs: o.idleThresholdMs, cooldownMs: o.cooldownMs, nudgeWindowMs: o.nudgeWindowMs,
      });
      (deps.writeVerdict || writeVerdict)(d.id, verdict, home, F);

      let poke = null;
      if (verdict.status === 'stale') {
        poke = (deps.pokeOrEscalate || pokeOrEscalate)(d, verdict, {
          home, now: o.now, nudgeMaxAttempts: o.nudgeMaxAttempts, nudgeCooldownMs: o.nudgeCooldownMs,
        }, deps.io);
      }
      results.push({ id: d.id, verdict, poke });
    } catch (e) {
      results.push({ id: d && d.id, error: String(e && e.message) });
    }
  }
  return results;
}

function main() {
  let release = null;
  try {
    const home = os.homedir();
    release = acquireSweepLock(home, {});
    if (!release) { process.exit(0); return; } // a prior sweep is still running — do not stack
    const t = resolveThresholdsFromEnv(process.env);
    const results = sweepOnce({
      home, idleThresholdMs: t.idleThresholdMs, cooldownMs: t.cooldownMs,
      nudgeMaxAttempts: t.nudgeMaxAttempts, nudgeWindowMs: t.nudgeWindowMs, nudgeCooldownMs: t.nudgeCooldownMs,
    });
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), sweep: results.length }) + '\n');
  } catch (_) {
    // absolute fail-safe: never throw out of the sweep
  } finally {
    try { if (release) release(); } catch (_) {}
    process.exit(0);
  }
}

if (require.main === module) main();

module.exports = {
  workspacesDir, readDescriptors, supervisorEnabled, sweepLockPath, acquireSweepLock, sweepOnce,
  parseEnvNum, resolveThresholdsFromEnv,
};
