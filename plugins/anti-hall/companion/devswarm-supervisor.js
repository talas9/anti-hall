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
const { pokeOrEscalate, notifyParentEscalation, DEFAULT_NUDGE_MAX_ATTEMPTS, DEFAULT_NUDGE_COOLDOWN_MS } = require('./lib/recovery.js');
// devswarm-repokey.js / devswarm-store.js are required LAZILY (inside
// readMeshUrgency, not at module top level). Only the devswarm-repokey.js
// lazy-require is load-bearing: repokey is NOT otherwise loaded anywhere in
// this module's top-level require chain, so a corrupt/missing repokey must
// fail OPEN at call time (readMeshUrgency's own try/catch -> null, no
// escalation) rather than crash this module's top-level require — this
// module is itself required at the TOP LEVEL by hooks/devswarm-parent-gate.js
// (readDescriptors). devswarm-store.js, by contrast, is ALREADY loaded by the
// time this module finishes loading — recovery.js (required above) top-level-
// requires devswarm-store.js and predates v0.58, so the store rides in via
// parent-gate -> supervisor -> recovery -> store regardless. Lazy-requiring it
// here too is harmless-but-consistent, not load-bearing.

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

// ----- mesh-urgency signal (v0.58 "mesh-only messaging" — additive Tier 0 wake) -----
// URGENT_TIERS — only these two deriveSummary urgencyMax values qualify as an
// urgent unread signal (deriveSummary's URGENCY_RANK: low=0, normal=1, high=2,
// urgent=3). 'low'/'normal'/absent -> not urgent: the sweep relies on the agent's
// own next turn (child-turn.js/parent-inbox.js already surface those), it does
// NOT force an escalate for them.
const URGENT_TIERS = new Set(['high', 'urgent']);

// readMeshUrgency(descriptor, home, deps) -> {urgencyMax, broadcastUrgencyMax,
// directUnread, broadcastUnread} | null. Resolves THIS descriptor's PROJECT repoKey the SAME
// way the codebase already does (repoKeyForWorktree — never re-hashed here), then
// reads that project's mesh-store projection `summaries/<repoKey>.json`
// (readSummaryForHash — the EXACT file the hooks read; see
// hooks/devswarm-parent-inbox.js's own summaryPath) and looks up THIS
// descriptor's own row (summary.workspaces[d.id] — deriveSummary keys the
// per-workspace projection by the registered workspace id). FAIL-OPEN throughout:
// an unresolvable repoKey (non-git worktree, no git binary), a missing/
// unreadable/malformed summary file, or a descriptor absent from
// summary.workspaces all return null ("no urgent signal") — this signal
// augments, it never blocks or throws out of, a sweep tick.
function readMeshUrgency(descriptor, home, deps) {
  const d = deps || {};
  try {
    const resolveRepoKey = d.repoKeyForWorktree || require('./lib/devswarm-repokey.js').repoKeyForWorktree;
    const readSummary = d.readSummaryForHash || require('./lib/devswarm-store.js').readSummaryForHash;
    const repoKey = resolveRepoKey(descriptor.worktreePath);
    if (!repoKey) return null;
    const summary = readSummary(home, repoKey, d.fs);
    if (!summary || typeof summary.workspaces !== 'object' || !summary.workspaces) return null;
    const w = summary.workspaces[descriptor.id];
    if (!w) return null;
    return {
      urgencyMax: w.urgencyMax != null ? String(w.urgencyMax) : null,
      // broadcastUrgencyMax (v0.58 P1 fix) — deriveSummary's max urgency among
      // this workspace's UNREAD non-heartbeat BROADCAST rows. Surfaced
      // separately from urgencyMax (which is direct-only) so isUrgentMesh can
      // treat an urgent/high broadcast as its own escalation trigger — a
      // broadcast previously carried no urgency signal at all here, so a
      // stale child with only an unread urgent broadcast (no direct message)
      // could never wake the supervisor.
      broadcastUrgencyMax: w.broadcastUrgencyMax != null ? String(w.broadcastUrgencyMax) : null,
      directUnread: Number.isFinite(w.directUnread) ? w.directUnread : 0,
      broadcastUnread: Number.isFinite(w.broadcastUnread) ? w.broadcastUnread : 0,
    };
  } catch (_) {
    return null;
  }
}

// isUrgentMesh(urgency) -> bool. `urgency` is readMeshUrgency's return (or
// null). True when EITHER the direct-row urgencyMax OR the broadcast-row
// broadcastUrgencyMax is high/urgent (v0.58 P1 fix — a broadcast used to
// carry no urgency signal here at all, so an urgent/high broadcast sitting
// unread for a stale child could never force an escalation).
function isUrgentMesh(urgency) {
  return !!(urgency && (URGENT_TIERS.has(urgency.urgencyMax) || URGENT_TIERS.has(urgency.broadcastUrgencyMax)));
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

        // Mesh-urgency escalation (v0.58 "mesh-only messaging", additive Tier 0
        // wake): an urgent/high unread in the project's mesh-store summary forces
        // a parent-store escalate notice NOW, independent of the poke budget/
        // cadence above (a stale-but-just-nudged workspace with a genuinely
        // urgent unread must not wait out the nudge window) — same
        // notifyParentEscalation channel pokeOrEscalate itself uses, so the
        // store-level hash dedupe (`escalate:<id>:<staleSince>`) keeps this
        // idempotent even when the base poke above already escalated on its own.
        // NEVER resolves a pid, NEVER kills. Low/normal urgency (or no mesh
        // signal at all) -> no forced escalate; rely on the agent's next turn.
        const urgency = (deps.readMeshUrgency || readMeshUrgency)(d, home, deps);
        if (isUrgentMesh(urgency)) {
          (deps.notifyParentEscalation || notifyParentEscalation)(d, verdict, {
            home, now: o.now, env,
          }, deps.openParentStore);
        }
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
  parseEnvNum, resolveThresholdsFromEnv, readMeshUrgency, isUrgentMesh, URGENT_TIERS,
};
