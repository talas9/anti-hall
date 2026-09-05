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
  devswarmRoot, computeLiveness, writeVerdict, isSafeId, rowLivenessState, isSessionAliveRow,
  DEFAULT_IDLE_MS, DEFAULT_COOLDOWN_MS, DEFAULT_NUDGE_WINDOW_MS,
} = require('./lib/liveness.js');
const { pokeOrEscalate, notifyParentEscalation, DEFAULT_NUDGE_MAX_ATTEMPTS, DEFAULT_NUDGE_COOLDOWN_MS } = require('./lib/recovery.js');
const alog = require('./lib/anti-hall-log.js'); // leaf module (fs/os/path only) — safe at top level, no cycle risk
// devswarm-archived-cache: leaf-ish (fs/path + liveness.js, which this file
// already loads). It lazy-requires THIS module for the sweep interval, so the
// cycle is never observed at load time — see its sweepIntervalMs().
const archivedCache = require('./lib/devswarm-archived-cache.js');
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

// ----- DEFECT 17685a91b783 (P1): post-spawn grace + done/archive-ready exclusion -----
// The automatic sweep was observed forcing a parent-store escalation notice
// ("child <id> idle 0m — reassign or archive") for a workspace whose descriptor
// had just been (re)registered, AND for a workspace the Primary had already
// ruled done. Two INDEPENDENT, additive suppressions, both applied ONLY to
// whether this sweep ACTS on a `stale` verdict (pokeOrEscalate + the
// mesh-urgency forced notify) — never to the verdict itself (writeVerdict still
// persists exactly what computeLiveness/liveness.js computed; this file does
// not own or alter that logic, see the DO-NOT-TOUCH list this fix is scoped
// under). Both fail CLOSED toward the pre-fix behavior (escalate) on any
// read/resolution failure — an unreadable signal must never silently suppress a
// genuine neglect notice; the NEGATIVE CONTROL in the paired test proves a
// genuinely idle-past-grace, non-done child is still poked/escalated normally.

// DEFAULT_POST_SPAWN_GRACE_MS (2 minutes) — the minimum runway a descriptor
// gets after its most recent (re)registration before this sweep will act on a
// stale verdict for it. Deliberately GENEROUS relative to a single sweep tick
// (launchd/systemd/cron intervals in this codebase are commonly 60-300s) but
// short relative to DEFAULT_IDLE_MS (15min) and DEFAULT_NEVER_LAUNCHED_MS (6h)
// so it can never mask real neglect for more than a couple of minutes — it
// exists purely to cover the register-to-first-turn gap (spawn scheduling,
// worktree creation, model cold-start), not to re-litigate the idle thresholds
// computeLiveness already owns.
const DEFAULT_POST_SPAWN_GRACE_MS = 2 * 60 * 1000;

// resolvePostSpawnGraceMs(env) -> ms, via the SAME parseEnvNum helper every
// other threshold in this file already uses. 0 is a valid override (grace
// disabled outright); clamped to [0, 1800] seconds so a typo can never turn
// this into an unbounded suppression.
function resolvePostSpawnGraceMs(env) {
  const sec = parseEnvNum(env || process.env, 'ANTIHALL_DEVSWARM_POST_SPAWN_GRACE_SEC',
    DEFAULT_POST_SPAWN_GRACE_MS / 1000, { min: 0, max: 1800 });
  return sec * 1000;
}

// descriptorFilePath(home, id) — the SAME path convention scripts/devswarm.js's
// own descriptorPath() uses (workspacesDir(home)/<id>.json); kept as a local
// copy (this file's own established idiom — see collapsedDescriptorFamilies'
// header on why cross-module coupling is avoided here) rather than importing
// the forbidden scripts/devswarm.js for one path join.
function descriptorFilePath(home, id) {
  return path.join(workspacesDir(home), String(id) + '.json');
}

// withinPostSpawnGrace(id, home, now, graceMs, fsi) -> bool. Uses the
// descriptor FILE's own mtime as the "most recent (re)registration" signal —
// register/ensure/re-home all rewrite this file via an atomic tmp+rename
// (scripts/devswarm.js writeDescriptorAtomic), so its mtime tracks the most
// recent registration event, not merely the workspace's original creation.
// FAIL-CLOSED (toward escalating, never toward suppressing): a disabled grace
// (graceMs <= 0), an unreadable/absent descriptor file, or a NEGATIVE age
// (the file's mtime is in the FUTURE relative to `now` — clock skew, or a
// forged mtime) all return false, i.e. "not in grace, evaluate normally".
// SKEW_TOLERANCE_MS — a small allowance for the mtime the fs clock reports
// reading marginally AHEAD of `now` (observed a few ms, immediately after a
// synchronous writeFileSync on this very machine — fs timestamp resolution and
// Date.now()'s clock source are not guaranteed to agree to sub-millisecond
// precision). Without this, a descriptor written microseconds ago could read
// as a NEGATIVE age and fail the grace check for the wrong reason (treated as
// "future/forged", the failure mode the null-return branch below exists for)
// on the exact case this feature is meant to cover. Only a skew LARGER than
// this (a genuinely forged or clock-skewed far-future mtime) still fails
// closed toward "not in grace" — see the fail-closed branch below.
const SKEW_TOLERANCE_MS = 5000;

function withinPostSpawnGrace(id, home, now, graceMs, fsi) {
  if (!(graceMs > 0)) return false;
  const F = fsi || fs;
  let ts = null;
  try {
    const st = F.statSync(descriptorFilePath(home, id));
    ts = Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
  } catch (_) { ts = null; }
  if (ts === null) return false;
  const age = now - ts;
  if (age < 0) return age >= -SKEW_TOLERANCE_MS; // benign clock jitter -> effectively age 0, in grace
  return age < graceMs;
}

// isArchiveReadyForSupervisor(id, worktreePath, home, deps) -> bool. Shares
// Defect A's derivation (hooks/devswarm-parent-gate.js's isArchiveReadyFor):
// once the Primary has ruled a child done+merged+tests_passed (the default
// required-gate set; `devswarm.js gate <id> --set ...`), the store already
// derives `archive_ready: true` into the per-project summary projection
// (companion/lib/devswarm-store.js deriveSummary) — the SAME summaries/
// <repoKey>.json file the gate reads. Kept as an independent local copy in
// THIS file rather than a cross-require of hooks/devswarm-parent-gate.js (that
// file is a Stop-hook script with side-effecting top-level code — `main()` is
// invoked unconditionally at require time — so requiring it from here would
// run a Stop hook's body as a side effect of loading the supervisor; the two
// copies read the exact same on-disk fact and must be kept in sync by hand).
// FAIL-CLOSED: any resolution/read/parse failure, or an id absent from the
// projection, returns false — never silently suppresses a real neglect notice.
function isArchiveReadyForSupervisor(id, worktreePath, home, deps) {
  const d = deps || {};
  try {
    const resolveRepoKey = d.repoKeyForWorktree || require('./lib/devswarm-repokey.js').repoKeyForWorktree;
    const repoKey = resolveRepoKey(worktreePath);
    if (!repoKey) return false;
    const F = d.fs || fs;
    const p = path.join(devswarmRoot(home), 'summaries', String(repoKey) + '.json');
    const raw = F.readFileSync(p, 'utf8').trim();
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.workspaces || typeof parsed.workspaces !== 'object') return false;
    const entry = parsed.workspaces[String(id)];
    return !!(entry && entry.archive_ready === true);
  } catch (_) {
    return false;
  }
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

// collapsedDescriptorFamilies(descriptors, deps) -> [{key, members, survivor}].
// READ-TIME identity-family collapse (companion/lib/devswarm-identity-family.js)
// — the SAME grouping hooks/devswarm-parent-gate.js applies to its own
// `readDescriptors` enumeration, so the supervisor's own reported "how many
// workspaces are being watched" view agrees with the gate's "N workspace(s)"
// count instead of drifting apart. Two descriptor FILES sharing one
// `worktreePath` (a builder-id UUID row and a slug row for the same physical
// worktree) collapse to ONE family here, purely for REPORTING — nothing here
// retires/deletes/writes any descriptor or state file, and `sweepOnce` below
// is DELIBERATELY left iterating the raw, uncollapsed `descriptors` list: each
// real descriptor still gets its own liveness verdict/poke, since a twin
// descriptor can carry its OWN distinct sessionId (the legitimate "two live
// tabs on one worktree" case the store-layer fold already protects).
// `deps.canonicalMeshId` is injectable for tests; the default lazily requires
// scripts/devswarm.js (same circular-require reasoning as reconcileSweepIfDue
// above — NEVER a top-level require in this file) and reuses its EXISTING
// `canonicalMeshId` derivation rather than reimplementing it. Fail-open: any
// failure (missing module, throwing resolver) yields one family per
// descriptor — today's uncollapsed behavior, never a crash.
function collapsedDescriptorFamilies(descriptors, deps) {
  const d = deps || {};
  const list = Array.isArray(descriptors) ? descriptors : [];
  try {
    const identityFamily = d.identityFamily || require('./lib/devswarm-identity-family.js');
    const resolveMeshId = d.canonicalMeshId || function (wt) {
      const devswarmCli = require('../scripts/devswarm.js');
      return devswarmCli.canonicalMeshId(wt);
    };
    const cache = new Map(); // worktreePath -> canonicalMeshId | null
    const resolve = (wt) => {
      if (cache.has(wt)) return cache.get(wt);
      let k = null;
      try { k = resolveMeshId(wt); } catch (_) { k = null; }
      cache.set(wt, k);
      return k;
    };
    return identityFamily.collapseFamilies(list, { resolve });
  } catch (_) {
    return list.map((desc) => ({ key: 'id:' + (desc && desc.id), members: [desc], survivor: desc }));
  }
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
        // DEFECT 17685a91b783 — see the suppression helpers' header above.
        // Evaluated ONCE per descriptor per tick, cheapest check first
        // (grace is a single fs.statSync; archive-ready needs a repoKey
        // resolution + a summary read, so it is skipped once grace already
        // suppresses).
        const nowTs = Number.isFinite(o.now) ? o.now : Date.now();
        const graceMs = Number.isFinite(o.postSpawnGraceMs) ? o.postSpawnGraceMs : resolvePostSpawnGraceMs(env);
        const graced = (deps.withinPostSpawnGrace || withinPostSpawnGrace)(d.id, home, nowTs, graceMs, F);
        const done = !graced && (deps.isArchiveReadyForSupervisor || isArchiveReadyForSupervisor)(d.id, d.worktreePath, home, deps);
        // R15 P3 FIX — SESSION-SOURCED LIVENESS (defect 699a236129c5) at the
        // SUPERVISOR too, not just the read-side gate/table. `computeLiveness`
        // above derives `stale` from ACTIVITY TIMESTAMPS alone (transcript/
        // worktree mtime), the exact axis that goes quiet for an interactive
        // session sitting at its prompt or a long autonomous turn — the same
        // gap devswarm-parent-gate.js's/devswarm-parent-inbox.js's own
        // `idleAlive` suppressors already close on the READ side. Without this,
        // the supervisor kept poking/escalating (writing verdicts, invoking
        // escalateCommand, notifying the parent store) a session it could have
        // confirmed via `rowLivenessState` was still a RUNNING harness process.
        // Evaluated only once graced/done have already failed to suppress
        // (cheapest-first, same ordering discipline as those two checks).
        // D12 (defect: false-positive escalation) — rowLivenessState's
        // dormancy gate is 30 min (DEFAULT_DORMANT_MS) while the stale gate
        // above is 15 min (DEFAULT_IDLE_MS): a row idle 15-30 min with a
        // transcript is 'active' by that state machine, so sessionPidAlive
        // was never consulted and a live-but-idle session could be escalated
        // outright on the first stale tick. Fix: consult isSessionAliveRow
        // DIRECTLY as a second, ONE-DIRECTIONAL suppressor alongside the
        // existing rowLivenessState check — a live session pid can only
        // SUPPRESS a poke/escalate, never assert one (rows with no real
        // sessionId fall through isSessionAliveRow -> false, unchanged).
        const rowForLiveness = { id: d.id, worktreePath: d.worktreePath, sessionId: d.sessionId };
        const idleAlive = !graced && !done
          && (
            (deps.rowLivenessState || rowLivenessState)(rowForLiveness, home, { now: nowTs }) === 'idle-alive'
            || (deps.isSessionAliveRow || isSessionAliveRow)(rowForLiveness, home, { now: nowTs })
          );
        if (graced || done || idleAlive) {
          poke = { action: 'suppressed', reason: graced ? 'post-spawn-grace' : (done ? 'archive-ready' : 'idle-alive') };
        } else {
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
          // Gated by the SAME graced/done suppression as the base poke above —
          // a just-spawned or already-done workspace must not be force-escalated
          // via this side door either.
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
//
// D12 item 5 (v0.96.1) — EXPLICIT BELT-AND-SUSPENDERS HARDENING, NOT A FIX
// for defect 3e000e49fe1b. That defect's stated mechanism (a stale worktree
// winning the representative slot over a live one for the same repoKey) was
// investigated and REFUTED: `resolve()` (the git-root probe in
// lib/devswarm-repokey.js) already requires the candidate path to exist —
// spawnSync ENOENTs on a missing cwd, so a deleted worktree's own resolve()
// call already fails and is skipped by the pre-existing `if (!key ...)
// continue` below, before it could ever reach `seen`. The real cause of that
// defect's field symptom (that one repoKey's hivecontrol-active.json entry
// never populating) is still open and is being traced separately via a
// read-only repro; this change does not close it.
//
// What THIS does: consults `deps.fs` (default real `fs`) via `existsSync`
// EXPLICITLY and independently of whatever `repoKeyForWorktree` happens to do
// internally, so the "prefer a live path" guarantee no longer rides on that
// resolver's incidental existence requirement — a defensive decoupling, kept
// because it is cheap and strictly does not weaken today's behavior, not
// because it was proven to fix a live incident.
//
// TWO-PASS, each descriptor visited exactly once (no redundant git spawns):
// PASS 1 restricts to worktreePaths that currently EXIST — first-resolving
// wins per repoKey, same semantics as before, just existence-gated. PASS 2 is
// the FALLBACK for a repoKey with no existing candidate at all — the
// pre-existing fail-open contract still applies (first descriptor wins), a
// stale representative there is no worse than today's behavior.
function distinctRepoKeys(descriptors, deps) {
  const d = deps || {};
  const F = d.fs || fs;
  const resolve = d.repoKeyForWorktree || function (wt) {
    try { return require('./lib/devswarm-repokey.js').repoKeyForWorktree(wt); } catch (_) { return null; }
  };
  const exists = (wt) => { try { return F.existsSync(wt); } catch (_) { return false; } };
  const list = descriptors || [];
  const seen = new Map();

  for (const desc of list) {
    if (!desc || !desc.worktreePath || !exists(desc.worktreePath)) continue;
    let key = null;
    try { key = resolve(desc.worktreePath); } catch (_) { key = null; }
    if (!key || seen.has(key)) continue;
    seen.set(key, desc.worktreePath);
  }
  for (const desc of list) {
    if (!desc || !desc.worktreePath || exists(desc.worktreePath)) continue; // already handled above
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
    // runFold(repoKey) — B1(a) fix: invoke the SAME canonical-fold primitive
    // doctor --repair/update already run (scripts/devswarm.js's
    // foldMeshDuplicates), but from THIS periodic, cooldown-gated sweep, so a
    // live slug/UUID partition split (fold logic already handles the pair —
    // groupRegistryByMeshId + isStaleCrossReference — but nothing on a LIVE
    // path ever invoked it) gets folded without waiting for a manual
    // doctor/update run. No new gate/lock/scheduling primitive: this rides
    // INSIDE the exact same reconcileSweepEnabled/cooldown gate and the same
    // single-flight supervisor sweep-lock (main()'s acquireSweepLock) the
    // reconcile call above already uses — `ctx.repoKey` bypasses cwd/git
    // resolution entirely, matching doctor-repair.js's own call shape. LAZY
    // require for the same circular-require reason as runReconcile above.
    // Ordering: runFold AFTER runReconcile per target, so a project that was
    // just reconciled (its native inbox freshly pulled into the registry) is
    // folded against its now-current state, not a stale pre-reconcile one.
    const runFold = deps.runFold || function (repoKey) {
      const devswarmCli = require('../scripts/devswarm.js');
      return devswarmCli.foldMeshDuplicates(home, { repoKey, env });
    };

    // runActiveList(worktreePath) — APP-SIDE ARCHIVE PROBE, BY ABSENCE (field:
    // the owner archived children in the DevSwarm app; nothing on anti-hall's
    // side ever learned, so those rows kept rendering as escalated/not-draining).
    // ONE bounded, read-only `hivecontrol workspace list all` per target, riding
    // INSIDE this same cooldown-gated, sweep-locked pass — no new scheduler, no
    // new lock, and NO reader ever spawns hivecontrol (see
    // companion/lib/devswarm-archived-cache.js's header). It caches the ACTIVE
    // set; "archived" is derived from absence at READ time under that lib's four
    // conjuncts. LAZY require for the same circular-require reason as
    // runReconcile/runFold above.
    const runActiveList = deps.runActiveList || function (worktreePath) {
      const devswarmCli = require('../scripts/devswarm.js');
      return devswarmCli.fetchActiveWorkspaceRecords({ home, env, cwd: worktreePath });
    };

    const results = [];
    let anyLost = false;
    const activeByRepoKey = {};
    let activeProbeFailure = null;
    for (const t of targets) {
      let result = null;
      try {
        result = runReconcile(t.worktreePath);
      } catch (e) {
        result = { ok: false, error: String(e && e.message || e) };
      }
      if (result && result.lost) anyLost = true;
      let fold = null;
      try {
        fold = runFold(t.repoKey);
      } catch (e) {
        fold = { ok: false, error: String(e && e.message || e) };
      }
      // Best-effort, per target. A probe failure NEVER contributes an entry —
      // "no data for this project" means no suppression, the fail-open
      // direction. THE THREE ADMISSION CONDITIONS, all required: the call
      // exited ok, it parsed as an array, and it carried AT LEAST ONE record.
      // The last one matters under absence semantics in a way it did not under
      // the old flag design: a zero-record answer (an empty array, or a CLI
      // error such as "Repository not found" surfaced as an empty body) would
      // otherwise be cached as "this project has no live workspaces" and
      // archive EVERY row in it. fetchActiveWorkspaceRecords reports that case
      // as `hivecontrol-empty-list` rather than ok, so it is refused here, and
      // writeActiveCache refuses it a second time independently.
      // The first failure is remembered so it can be logged ONCE per sweep
      // (not once per project).
      let active = null;
      try {
        active = runActiveList(t.worktreePath);
      } catch (e) {
        active = { ok: false, reason: 'probe-threw', error: String(e && e.message || e) };
      }
      if (active && active.ok && Array.isArray(active.records) && active.records.length) {
        activeByRepoKey[t.repoKey] = active.records;
      } else if (active && !active.ok && !activeProbeFailure) {
        activeProbeFailure = { repoKey: t.repoKey, reason: active.reason || 'unknown', rawKeys: active.rawKeys || [] };
      }
      results.push({ repoKey: t.repoKey, worktreePath: t.worktreePath, result, fold, active });
    }

    // Write the cache only when at least one target actually reported records.
    // Under absence semantics an empty write is NOT harmless — it would stamp a
    // FRESH fetchedAt on a snapshot asserting that nothing is live. Skipping it
    // leaves the previous (soon-to-expire) snapshot to age out on its own, which
    // ends in "no suppression", the fail-open direction.
    if (Object.keys(activeByRepoKey).length) {
      try {
        (deps.writeActiveCache || archivedCache.writeActiveCache)({ home, byRepoKey: activeByRepoKey, now, fsi: F });
      } catch (_) { /* cache write must never break the sweep */ }
    }
    if (activeProbeFailure) {
      try {
        alog.logEvent('devswarm-supervisor', 'active-probe', 'info',
          'hivecontrol workspace list returned no usable records — app-side archive detection is OFF this cycle (nothing written, nothing suppressed)',
          activeProbeFailure);
      } catch (_) { /* logging must never break the sweep */ }
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

    return { ran: true, projects: targets.length, skipped: projects.length - targets.length, results,
      // activeProbe: report-only provenance for the app-side archive probe —
      // which projects contributed an active snapshot this tick, and the FIRST
      // failure reason if any probe came back unusable. There is no field to
      // report any more (archive is derived from absence, not a flag), so this
      // replaces the old `archivedField`.
      activeProbe: {
        repoKeys: Object.keys(activeByRepoKey),
        failure: activeProbeFailure,
      } };
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
    // Deferred post-update sweep backstop (task #40) — rides inside this SAME
    // single-flight sweep-lock hold, one bounded stage-slot per pass.
    const deferredSweep = deferredSweepIfDue({ home });
    // `sweepFamilies` (identity-family collapsed) rides ALONGSIDE the existing
    // `sweep` field (raw per-descriptor count, unchanged — still what
    // sweepOnce actually iterated/wrote verdicts for) rather than replacing
    // it, so this reporting-only view addition can never regress anything
    // that already reads `sweep`. Reads descriptors fresh (cheap fs read,
    // same primitive sweepOnce itself just used) rather than threading
    // worktreePath through sweepOnce's per-result shape.
    let sweepFamilies = results.length;
    try { sweepFamilies = collapsedDescriptorFamilies(readDescriptors(home)).length; } catch (_) { /* fail-open: keep raw count */ }
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), sweep: results.length, sweepFamilies, reconcile, deferredSweep }) + '\n');
  } catch (_) {
    // absolute fail-safe: never throw out of the sweep
  } finally {
    try { if (release) release(); } catch (_) {}
    process.exit(0);
  }
}

// ============================================================================
// DEFERRED POST-UPDATE SWEEP BACKSTOP (task #40, v0.96.1) — see update.js's
// postPullBudgetMs doc comment: `ANTIHALL_UPDATE_POSTPULL_BUDGET_MS` (D11-C,
// defect e7307778b614) caps every DevSwarm post-pull stage COMBINED, and a
// machine that always exhausts it defers fold-all-stores/heal-orphan-
// partitions/fold-archived-rows WHOLE on EVERY `update`/`doctor` run. Unlike
// reconcile/fold (already covered above by reconcileSweepIfDue's own
// cooldown-gated periodic re-run), nothing periodic ever picked those three
// back up — they relied SOLELY on the next explicit update/doctor call,
// which never comes on a machine whose backlog is large enough to always
// blow the budget. This gives the already-installed periodic sweep a
// bounded per-pass slot: at most ONE deferred stage per pass, rotating in a
// fixed order, and ONLY when that stage's OWN resume/sweep-state marker
// shows deferred work is genuinely pending — a no-op tick costs one cheap
// marker read, never a store re-enumeration.
//
// NO NEW FOLD/HEAL LOGIC HERE: this reuses update.js's own stage functions
// (foldAllStoresPostUpdate / healOrphanPartitionsPostUpdate /
// foldArchivedRowsPostUpdate) verbatim — this section is a scheduling slot
// around them, nothing more.
//
// GATE-OPEN OVERRIDE (deliberate): those update.js stage functions each gate
// on `isDevswarmActive(env)` internally (hooks/lib/devswarm-detect.js) —
// correct for the `update`/`doctor` call site they were written for (skip
// entirely on a plain non-DevSwarm run), but a launchd/systemd/cron-invoked
// supervisor process carries no per-session `DEVSWARM_REPO_ID` at all, so
// `auto` mode would gate-closed EVERY call unconditionally, silently making
// this whole feature a no-op in the real deployed daemon. This module already
// independently proved DevSwarm is genuinely in use before ever reaching this
// code (this pass only runs when `hasDeferredWork` finds a REAL persisted
// marker a DevSwarm session created on disk), so `runDeferredStage` passes a
// SCOPED COPY of env with `ANTIHALL_DEVSWARM_SUPERVISOR: 'on'` forced —
// `isDevswarmActive`'s own documented unconditional-true override — to the
// stage call only, never mutating the caller's real env.
// ============================================================================

const DEFERRED_SWEEP_STAGES = ['fold-all-stores', 'heal-orphan-partitions', 'fold-archived-rows'];
const DEFAULT_SUPERVISOR_SWEEP_BUDGET_MS = 20000; // 20s per-pass slot, mirrors update.js's own DEFAULT_SWEEP_BUDGET_MS
const DEFERRED_SWEEP_STATE_FILE = 'deferred-sweep-state.json';

function deferredSweepStatePath(home) {
  return path.join(devswarmRoot(home), DEFERRED_SWEEP_STATE_FILE);
}

// readDeferredSweepState/writeDeferredSweepState — a small, independent state
// file tracking only `{ nextStageIndex }` (the rotation cursor). Fail-open:
// unreadable/corrupt/absent -> index 0 (start of rotation), never thrown.
// Same atomic tmp+rename write discipline as reconcileSweepStatePath above.
function readDeferredSweepState(home, F) {
  const Fi = F || fs;
  try {
    const parsed = JSON.parse(Fi.readFileSync(deferredSweepStatePath(home), 'utf8'));
    const idx = Number.isFinite(parsed && parsed.nextStageIndex) ? parsed.nextStageIndex : 0;
    const n = DEFERRED_SWEEP_STAGES.length;
    return { nextStageIndex: ((idx % n) + n) % n };
  } catch (_) {
    return { nextStageIndex: 0 };
  }
}
function writeDeferredSweepState(home, F, state) {
  const Fi = F || fs;
  try {
    const p = deferredSweepStatePath(home);
    Fi.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid;
    Fi.writeFileSync(tmp, JSON.stringify(state));
    Fi.renameSync(tmp, p);
  } catch (_) { /* fail-open: the rotation cursor is best-effort, never load-bearing for correctness */ }
}

// resolveSupervisorSweepBudgetMs(env) -> ms, ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS-
// overridable. Deliberately an absolute-ms knob (like update.js's own
// sweepBudgetMs/postPullBudgetMs), NOT a *_SEC var like this file's liveness
// thresholds above — it feeds straight into update.js's own ms-based budget
// plumbing (ANTIHALL_UPDATE_SWEEP_BUDGET_MS), so the units must line up
// without a seconds<->ms conversion at the boundary.
function resolveSupervisorSweepBudgetMs(env) {
  const raw = (env || process.env || {}).ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SUPERVISOR_SWEEP_BUDGET_MS;
}

// hasDeferredWork(stage, home, deps) -> bool. Peeks the stage's OWN persisted
// resume/sweep-state marker WITHOUT doing any of its work — a cheap read,
// never a listStoreHashes/directory walk. Fail-open to false: an absent or
// corrupt marker reads as "nothing pending", the same posture every marker
// reader in this codebase already takes (readSweepState/readFoldArchivedResume
// etc. are themselves fail-open; this only adds the "is it non-empty" check).
function hasDeferredWork(stage, home, deps) {
  const d = deps || {};
  try {
    if (stage === 'fold-all-stores' || stage === 'heal-orphan-partitions') {
      const updateJs = d.updateJs || require('../skills/update/scripts/update.js');
      const key = stage === 'fold-all-stores' ? 'foldAllStores' : 'healOrphanPartitions';
      const state = updateJs.readSweepState(home);
      const entry = state[key];
      return !!(entry && entry.pendingVersion && Array.isArray(entry.pendingHashes) && entry.pendingHashes.length > 0);
    }
    if (stage === 'fold-archived-rows') {
      const devswarmCli = d.devswarm || require('../scripts/devswarm.js');
      const buckets = devswarmCli.readFoldArchivedResume(home) || {};
      const anyBucketPending = Object.keys(buckets).some((k) => Array.isArray(buckets[k]) && buckets[k].length > 0);
      const famIds = devswarmCli.readFoldArchivedFamilyResume(home) || [];
      return anyBucketPending || (Array.isArray(famIds) && famIds.length > 0);
    }
  } catch (_) { /* fail-open: a marker read failure reads as nothing pending */ }
  return false;
}

// runDeferredStage(stage, opts) -> the stage function's OWN result shape (see
// update.js's foldAllStoresPostUpdate/healOrphanPartitionsPostUpdate/
// foldArchivedRowsPostUpdate doc comments) — never re-implemented here.
// opts: { home, env, budgetMs, cwd, now, deps: { updateJs, devswarm } }.
function runDeferredStage(stage, opts) {
  const o = opts || {};
  const home = o.home;
  const env = o.env || process.env;
  const deps = o.deps || {};
  const updateJs = deps.updateJs || require('../skills/update/scripts/update.js');
  const budgetMs = Number.isFinite(o.budgetMs) ? o.budgetMs : resolveSupervisorSweepBudgetMs(env);
  const nowFn = o.now || Date.now;
  // Deliberately NOT updateJs.resolvePaths(env, home): that resolves a
  // MARKETPLACE-clone-relative path under `home` (the update/doctor CLI's own
  // installed-plugin layout), which has no relationship to where THIS
  // supervisor process's own code actually lives — a launchd/systemd/cron
  // `home` carries no marketplace clone at all. This module already lazily
  // requires '../scripts/devswarm.js' relative to its OWN location elsewhere
  // in this file (see hasDeferredWork above); pluginSrcDir here is that same
  // real, currently-running plugin source directory (one level up from
  // companion/), never a home-derived guess.
  const paths = deps.paths || { pluginSrcDir: path.resolve(__dirname, '..') };
  // Threads THIS pass's own budget into the SAME knob update.js's own sweeps
  // already read (ANTIHALL_UPDATE_SWEEP_BUDGET_MS via sweepBudgetMs), and
  // forces the isDevswarmActive gate open (see the section header above) —
  // both scoped to THIS call only, never mutating the caller's real env.
  const scopedEnv = Object.assign({}, env, {
    ANTIHALL_UPDATE_SWEEP_BUDGET_MS: String(budgetMs),
    ANTIHALL_DEVSWARM_SUPERVISOR: 'on',
  });
  const commonOpts = { paths, env: scopedEnv, cwd: o.cwd || process.cwd(), home, devswarm: deps.devswarm, now: nowFn };
  if (stage === 'fold-all-stores' || stage === 'heal-orphan-partitions') {
    // The pending VERSION comes off the stage's OWN sweep-state entry (never
    // recomputed here) so sweepItemsFor's resume branch matches and picks up
    // exactly the pendingHashes list a prior budget-exhausted pass left —
    // never a fresh listStoreHashes() full re-enumeration.
    const key = stage === 'fold-all-stores' ? 'foldAllStores' : 'healOrphanPartitions';
    const state = updateJs.readSweepState(home);
    const entry = state[key] || {};
    const version = entry.pendingVersion || null;
    const fn = stage === 'fold-all-stores' ? updateJs.foldAllStoresPostUpdate : updateJs.healOrphanPartitionsPostUpdate;
    return fn(Object.assign({}, commonOpts, { version }));
  }
  if (stage === 'fold-archived-rows') {
    // foldArchivedRowsPostUpdate self-resumes off its own fold-archived-
    // resume.json / fold-archived-family-resume.json markers — no
    // version/hashes plumbing needed from this caller.
    return updateJs.foldArchivedRowsPostUpdate(commonOpts);
  }
  return { attempted: false, detail: stage + ': unknown deferred-sweep stage' };
}

// deferredSweepIfDue(opts) -> { stage, ran:false, reason } | { stage, ran:true,
// budgetMs, result }. Never throws. Rotates ONE stage forward per call
// REGARDLESS of outcome (persisted BEFORE running/peeking, same ordering
// rationale as reconcileSweepIfDue's own persist-before-run above) — a
// no-op tick still advances so the NEXT pass checks a DIFFERENT stage rather
// than getting stuck re-peeking the same one forever.
function deferredSweepIfDue(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const deps = o.deps || {};
  const F = deps.fs || fs;
  try {
    if (!supervisorEnabled(env)) return { stage: null, ran: false, reason: 'disabled' };

    const state = (deps.readDeferredSweepState || readDeferredSweepState)(home, F);
    const stage = DEFERRED_SWEEP_STAGES[state.nextStageIndex];
    const nextIndex = (state.nextStageIndex + 1) % DEFERRED_SWEEP_STAGES.length;
    (deps.writeDeferredSweepState || writeDeferredSweepState)(home, F, { nextStageIndex: nextIndex });

    const pending = (deps.hasDeferredWork || hasDeferredWork)(stage, home, deps);
    if (!pending) return { stage, ran: false, reason: 'no-marker' };

    const budgetMs = Number.isFinite(o.budgetMs) ? o.budgetMs : resolveSupervisorSweepBudgetMs(env);
    const result = (deps.runDeferredStage || runDeferredStage)(stage, { home, env, budgetMs, now: o.now, deps });
    return { stage, ran: true, budgetMs, result };
  } catch (e) {
    return { stage: null, ran: false, error: String(e && e.message || e) };
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
  workspacesDir, readDescriptors, collapsedDescriptorFamilies, supervisorEnabled, sweepLockPath, acquireSweepLock, sweepOnce,
  parseEnvNum, resolveThresholdsFromEnv, readMeshUrgency, isUrgentMesh, URGENT_TIERS,
  reconcileSweepIfDue, reconcileSweepEnabled, resolveReconcileCooldownMs, distinctRepoKeys,
  reconcileSweepStatePath, readReconcileSweepState, writeReconcileSweepState,
  DEFAULT_RECONCILE_SWEEP_COOLDOWN_MS, MAX_RECONCILE_PROJECTS_PER_TICK,
  // DEFECT 17685a91b783
  DEFAULT_POST_SPAWN_GRACE_MS, resolvePostSpawnGraceMs, descriptorFilePath,
  withinPostSpawnGrace, isArchiveReadyForSupervisor,
  // task #40 (v0.96.1) — deferred post-update sweep backstop:
  deferredSweepIfDue, hasDeferredWork, runDeferredStage,
  deferredSweepStatePath, readDeferredSweepState, writeDeferredSweepState,
  resolveSupervisorSweepBudgetMs, DEFAULT_SUPERVISOR_SWEEP_BUDGET_MS, DEFERRED_SWEEP_STAGES,
};

if (require.main === module) main();
