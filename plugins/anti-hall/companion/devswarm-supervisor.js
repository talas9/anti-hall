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
const alog = require('./lib/anti-hall-log.js'); // leaf module (fs/os/path only) — safe at top level, no cycle risk
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
//
// scripts/devswarm.js (the reconcile-sweep's CLI entry point, C4 below) is
// required LAZILY INSIDE reconcileSweepIfDue for a STRONGER reason than the
// two above: it is genuinely CIRCULAR — scripts/devswarm.js itself top-level-
// requires THIS module (for readDescriptors). A top-level require here would
// deadlock into Node's partial-exports behavior whenever THIS module is the
// one first loaded as `require.main` (i.e. run directly by launchd/systemd/
// cron, exactly how install-devswarm-supervisor.js deploys it): see the
// module.exports/require.main reordering note at the bottom of this file for
// why that specific direction is otherwise unsafe.

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
        descriptor: d, now: o.now, home, env, runners: deps.runners,
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
          // Thread the SAME injected fs (F, already used above for
          // readDescriptors/writeVerdict/computeLiveness) through to
          // notifyParentEscalation's opts — matching how the neighbouring
          // pokeOrEscalate call site passes `fsi: F` into its own internal
          // notifyParentEscalation call (lib/recovery.js). Without this, a
          // test/sandbox that injects fs here still leaks the forced-escalate
          // path to the real filesystem.
          (deps.notifyParentEscalation || notifyParentEscalation)(d, verdict, {
            home, now: o.now, env, fsi: F,
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

// ============================================================================
// RECONCILE SWEEP (C4 — trigger-less recovery). Verified: `devswarm.js
// reconcile` (drains stranded per-worktree native queues into the shared
// store) was MANUAL-only — `update` runs it post-update and `doctor` only
// under an explicit --fix gate; this periodic liveness sweep never ran it at
// all. Field consequence: 1,440 messages sat stranded across 23 worktrees
// until an update happened to run reconcile (the recovery itself, once
// triggered, was lossless — the gap was purely "nothing triggers it
// automatically"). This gives the ALREADY-installed periodic supervisor a
// COOLDOWN-GATED sweep that periodically invokes the EXISTING reconcile entry
// point (scripts/devswarm.js's `run(['reconcile'], ctx)` — the exact
// programmatic call doctor-repair.js already makes) — no new recovery
// mechanism, no parallel lock, no reimplementation of the drain itself.
//
// LOCK REUSE (hard constraint): `run(['reconcile'])` -> cmdReconcile spawns
// `inbox pull <id>` as a subprocess per descriptor, cwd=that worktree, which
// runs cmdInboxPull -> devswarm-pull.js's pullOnce -> acquireExclLock (the
// SAME per-id O_EXCL `openSync(p,'wx')` lock a live child's own `inbox pull`
// already uses). This sweep therefore acquires that SAME lock via the SAME
// existing call path — it never opens a lock of its own — so it cannot race a
// live drain: whichever of the two (this sweep's subprocess, or a live
// child's own pull) gets there first wins the lock; the other observes
// `locked:true` in cmdReconcile's per-target result and is skipped for THIS
// tick, never blocked on, never corrupted.
//
// NON-DESTRUCTIVE + IDEMPOTENT: reconcile/inbox-pull never deletes source
// messages (verified: no unlink/rm of message data anywhere in
// devswarm-pull.js — only lock-file bookkeeping); re-running it on an
// already-drained project is a no-op (imported:0).
//
// BOUNDED: (1) cooldown-gated — at most one reconcile-sweep attempt per
// RECONCILE_SWEEP_COOLDOWN_MS (default 15min, env-tunable, floor 5min so a
// typo'd override can never turn this into a per-tick hammer); (2) capped —
// at most MAX_RECONCILE_PROJECTS_PER_TICK distinct projects per attempt (a
// project skipped this tick is simply retried on a later cooldown-gated
// tick — never lossy, just deferred); (3) each underlying `inbox pull`
// subprocess already carries its own 30s spawn timeout (defaultSpawnReconcile
// in scripts/devswarm.js) — this sweep inherits that bound for free by
// reusing the same call path rather than reimplementing it.
//
// FAIL-OPEN throughout: this feature must never crash or hang the liveness
// sweep it rides alongside. Every layer (state read/write, repoKey
// resolution, the reconcile call itself) is individually try/caught; a
// failure anywhere degrades to "skip this tick", never a thrown error.
// ============================================================================

const DEFAULT_RECONCILE_SWEEP_COOLDOWN_MS = 15 * 60 * 1000; // 15 min
const RECONCILE_SWEEP_STATE_FILE = 'reconcile-sweep-state.json';
// Soft bound on distinct PROJECTS (repoKeys) reconciled in one tick — keeps a
// single tick's worst-case latency bounded even on a machine with many active
// projects. Not env-tunable (deliberately small, fixed surface area): a
// project excluded this tick is picked up on a later cooldown-gated tick, so
// this is a fairness/latency cap, never a lossiness risk.
const MAX_RECONCILE_PROJECTS_PER_TICK = 10;

function reconcileSweepStatePath(home) {
  return path.join(devswarmRoot(home), RECONCILE_SWEEP_STATE_FILE);
}

// reconcileSweepEnabled(env) — off / hard-kill gates, PLUS its own dedicated
// sub-toggle so an owner can keep the liveness sweep (poke/escalate) while
// opting OUT of the automatic reconcile invocation specifically (e.g. while
// diagnosing a reconcile-side issue) without disabling the whole supervisor.
function reconcileSweepEnabled(env) {
  const e = env || process.env;
  if (!supervisorEnabled(e)) return false;
  return String(e.ANTIHALL_DEVSWARM_RECONCILE_SWEEP || 'auto').trim().toLowerCase() !== 'off';
}

// resolveReconcileCooldownMs(env) -> ms, floor 5min (see BOUNDED above).
function resolveReconcileCooldownMs(env) {
  const sec = parseEnvNum(env || process.env, 'ANTIHALL_DEVSWARM_RECONCILE_SWEEP_SEC',
    DEFAULT_RECONCILE_SWEEP_COOLDOWN_MS / 1000, { min: 300 });
  return sec * 1000;
}

// readReconcileSweepState/writeReconcileSweepState — a small, independent,
// additive state file (NOT the liveness verdict, NOT the sweep lock) tracking
// only `{ lastRunAt }`. Fail-open: unreadable/corrupt/absent -> lastRunAt:0,
// i.e. "never run" -> ELIGIBLE NOW. This fails open TOWARD sweeping, not away
// from it — deliberately the opposite polarity of e.g. the parent-gate's
// unknown-blocks convention, because running reconcile is itself safe,
// idempotent, and non-destructive (see header), so the worse failure mode
// here is staying silent (the ORIGINAL C4 bug), not sweeping an extra time.
function readReconcileSweepState(home, F) {
  try {
    const parsed = JSON.parse(F.readFileSync(reconcileSweepStatePath(home), 'utf8'));
    return { lastRunAt: Number.isFinite(parsed && parsed.lastRunAt) ? parsed.lastRunAt : 0 };
  } catch (_) {
    return { lastRunAt: 0 };
  }
}
function writeReconcileSweepState(home, F, state) {
  try {
    const p = reconcileSweepStatePath(home);
    F.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid;
    F.writeFileSync(tmp, JSON.stringify(state));
    F.renameSync(tmp, p); // atomic — a crash mid-write can never leave a torn state file
  } catch (_) { /* fail-open: rate-limiting is best-effort only, never load-bearing for correctness */ }
}

// distinctRepoKeys(descriptors, deps) -> [{repoKey, worktreePath}], one
// representative worktreePath per distinct repoKey. `deps.repoKeyForWorktree`
// is injectable (tests); default lazily requires devswarm-repokey.js (same
// lazy-require discipline readMeshUrgency above already uses — repokey is not
// otherwise on this module's top-level require chain). Fail-open per
// descriptor: an unresolvable repoKey (non-git worktree, missing git binary)
// is skipped, never thrown — this signal only exists to discover WHICH
// projects are active; the real reconcile call re-derives its own repoKey
// from cwd independently regardless of what we pass in here.
function distinctRepoKeys(descriptors, deps) {
  const d = deps || {};
  const resolve = d.repoKeyForWorktree || function (wt) {
    try { return require('./lib/devswarm-repokey.js').repoKeyForWorktree(wt); } catch (_) { return null; }
  };
  const seen = new Map();
  for (const desc of (descriptors || [])) {
    if (!desc || !desc.worktreePath) continue;
    let key = null;
    try { key = resolve(desc.worktreePath); } catch (_) { key = null; }
    if (!key || seen.has(key)) continue;
    seen.set(key, desc.worktreePath);
  }
  const out = [];
  for (const [repoKey, worktreePath] of seen) out.push({ repoKey, worktreePath });
  return out;
}

// reconcileSweepIfDue(opts) -> { ran, reason? } | { ran:true, projects,
// skipped, results }. Never throws. opts: { home, env, now, cooldownMs,
// maxProjectsPerTick, deps: { fs, readDescriptors, repoKeyForWorktree,
// readReconcileSweepState, writeReconcileSweepState, runReconcile } } — all
// injectable so tests never spawn a real subprocess or touch real git.
function reconcileSweepIfDue(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const deps = o.deps || {};
  const F = deps.fs || fs;

  try {
    if (!reconcileSweepEnabled(env)) return { ran: false, reason: 'disabled' };

    const cooldownMs = Number.isFinite(o.cooldownMs) ? o.cooldownMs : resolveReconcileCooldownMs(env);
    const state = (deps.readReconcileSweepState || readReconcileSweepState)(home, F);
    if ((now - state.lastRunAt) < cooldownMs) return { ran: false, reason: 'cooldown' };

    const descriptors = (deps.readDescriptors || readDescriptors)(home, F);
    if (!descriptors || !descriptors.length) return { ran: false, reason: 'no-descriptors' };

    const projects = distinctRepoKeys(descriptors, deps);
    if (!projects.length) return { ran: false, reason: 'no-resolvable-projects' };

    // Persist BEFORE running (mirrors devswarm-parent-gate.js's persist-
    // before-block ordering): a slow or crashing reconcile call still honors
    // the cooldown for the NEXT tick rather than being retried every tick.
    (deps.writeReconcileSweepState || writeReconcileSweepState)(home, F, { lastRunAt: now });

    const cap = Number.isFinite(o.maxProjectsPerTick) ? o.maxProjectsPerTick : MAX_RECONCILE_PROJECTS_PER_TICK;
    const targets = projects.slice(0, Math.max(0, cap));

    // runReconcile(worktreePath) -> the reconcile call result shape ({ok,
    // count, imported, lost, rejected, ...} — see scripts/devswarm.js's
    // cmdReconcile) or { ok:false, error } on failure. LAZY require (see the
    // top-of-file comment): scripts/devswarm.js top-level-requires THIS
    // module, so requiring it here at call time (never at module top level)
    // is what keeps the cycle from ever observing partial exports.
    const runReconcile = deps.runReconcile || function (worktreePath) {
      const devswarmCli = require('../scripts/devswarm.js');
      const { result } = devswarmCli.run(['reconcile'], { home, env, cwd: worktreePath });
      return result;
    };

    const results = [];
    let anyLost = false;
    for (const t of targets) {
      let result = null;
      try {
        result = runReconcile(t.worktreePath);
      } catch (e) {
        result = { ok: false, error: String(e && e.message || e) };
      }
      if (result && result.lost) anyLost = true;
      results.push({ repoKey: t.repoKey, worktreePath: t.worktreePath, result });
    }

    // OBSERVE, DON'T ASSERT: log exactly what the (real, already-executed)
    // reconcile calls reported — never a claim of health beyond what was
    // actually returned. `warn` when any target reported a real loss
    // shortfall (cmdReconcile's own `lost` field — a genuine shortfall, never
    // a benign lock-contention skip), `info` otherwise.
    try {
      alog.logEvent('devswarm-supervisor', 'reconcile-sweep', anyLost ? 'warn' : 'info',
        'reconcile-sweep: ' + targets.length + ' project(s) attempted' + (projects.length > targets.length ? ', ' + (projects.length - targets.length) + ' deferred to a later tick' : ''),
        { results: results.map((r) => ({ repoKey: r.repoKey, ok: !!(r.result && r.result.ok), imported: (r.result && r.result.imported) || 0, lost: (r.result && r.result.lost) || 0 })) });
    } catch (_) { /* logging must never break the sweep */ }

    return { ran: true, projects: targets.length, skipped: projects.length - targets.length, results };
  } catch (e) {
    return { ran: false, error: String(e && e.message || e) };
  }
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
    // Reconcile sweep (C4) rides INSIDE the same single-flight sweep-lock hold
    // as the liveness sweep above — never a parallel/independent lock — so two
    // overlapping supervisor ticks can never both attempt it at once either.
    const reconcile = reconcileSweepIfDue({ home });
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), sweep: results.length, reconcile }) + '\n');
  } catch (_) {
    // absolute fail-safe: never throw out of the sweep
  } finally {
    try { if (release) release(); } catch (_) {}
    process.exit(0);
  }
}

// module.exports MUST be assigned BEFORE the require.main-gated main() call
// below, NOT after (the pre-C4 order). Reasoning: main() (via
// reconcileSweepIfDue's lazy require) can now load scripts/devswarm.js, which
// itself top-level-requires THIS module (`const { readDescriptors } =
// require('../companion/devswarm-supervisor.js')`, line ~128 of that file) —
// genuinely circular. When THIS module is `require.main` (the real deployment
// shape: launchd/systemd/cron invoke `node devswarm-supervisor.js` directly),
// Node reaches the `if (require.main === module) main()` line DURING this
// module's own top-level execution — if module.exports were assigned AFTER
// that line (as it was pre-C4), scripts/devswarm.js's require of this module
// mid-main() would observe the DEFAULT EMPTY exports object (not yet
// reassigned), silently binding its own `readDescriptors` to `undefined` for
// the rest of its lifetime. That specific landmine was latent-but-harmless
// pre-C4 (nothing this module's own runtime code ever required
// scripts/devswarm.js), but C4's reconcile-sweep is exactly the code path
// that can now trigger it — so the export assignment is reordered ahead of
// the main() call, closing it unconditionally rather than relying on this
// particular call graph never exercising it.
module.exports = {
  workspacesDir, readDescriptors, supervisorEnabled, sweepLockPath, acquireSweepLock, sweepOnce,
  parseEnvNum, resolveThresholdsFromEnv, readMeshUrgency, isUrgentMesh, URGENT_TIERS,
  reconcileSweepIfDue, reconcileSweepEnabled, resolveReconcileCooldownMs, distinctRepoKeys,
  reconcileSweepStatePath, readReconcileSweepState, writeReconcileSweepState,
  DEFAULT_RECONCILE_SWEEP_COOLDOWN_MS, MAX_RECONCILE_PROJECTS_PER_TICK,
};

if (require.main === module) main();
