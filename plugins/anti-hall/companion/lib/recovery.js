'use strict';
// anti-hall :: recovery — two DISTINCT, independent mechanisms living in one
// file. Workaround for claude-code#39755.
//
//   1. pokeOrEscalate() — the AUTOMATIC path (called by devswarm-supervisor.js's
//      sweep on a `stale` verdict). NEVER kills, NEVER resolves a pid. Its tools
//      are a soft nudge (an optional descriptor-supplied nudgeCommand) and an
//      escalate signal (a recovery.log line, an optional escalateCommand, AND — on
//      the transition into escalated — a mechanically-appended notice in the
//      PARENT/Primary's store via notifyParentEscalation, so an idle parent learns
//      without taking a turn; see notifyParentEscalation below for the dedupe
//      story).
//   2. recover() — kill the ONE confirmed wedged `claude` pid (and its process
//      group) and resume it headless from the same worktree cwd, feeding the
//      unread backlog as the fresh prompt. This is the ONLY path in DevSwarm that
//      ever kills anything, and it is ON-DEMAND ONLY — invoked by the
//      devswarm-recover.js CLI for one named workspace, never by the automatic
//      sweep.
//
// SAFETY INVARIANTS for recover() (each proven by a test):
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
const lockLib = require('./lock.js');
const { spawn } = require('child_process');
const { devswarmRoot, livenessPathFor, writeVerdict, unreadBacklog, isSafeId } = require('./liveness.js');
const { verifyTarget } = require('./target-session.js');
const devswarmStore = require('./devswarm-store.js');
const { primaryWorkspaceId, resolveMainWorktree } = require('../install-devswarm-ingest.js');
// D27 (mirrors install-devswarm-ingest.js:46-55, devswarm-store.js:53): GUARDED, not
// a bare require. This module is itself required TOP-LEVEL by devswarm-supervisor.js:41
// (the sweep loop) and scripts/devswarm.js:129, whose fail-open guarantees wrap their
// own call sites but NOT their top-level requires. A THROWING require here (a corrupt/
// deleted devswarm-repokey.js) would crash BOTH consumers before fail-open ever engages.
// `repokey` is null on failure; safeRepoKey() below already fails open when it is.
let repokey = null;
try { repokey = require('./devswarm-repokey.js'); } catch (_) { repokey = null; }

const DEFAULT_MAX_RECOVERIES = 3;
const DEFAULT_GRACE_MS = 5000;
const DEFAULT_NUDGE_MAX_ATTEMPTS = 2;
const DEFAULT_NUDGE_COOLDOWN_MS = 2 * 60 * 1000; // min gap between successive pokes
const LOCK_STALE_MS = 15 * 60 * 1000; // TTL backstop; the dead-holder probe is the primary steal signal
const RESUME_READINESS_MS = 4000;     // how long to watch a fresh resume for an immediate error — NEVER a kill deadline

// RESUME_GUARDRAIL — PREPENDED to every --resume prompt. A real mid-turn-kill
// test showed the resumed model otherwise blindly re-ran an identical mutating
// command (it couldn't see whether the interrupted one had already succeeded),
// causing a double execution. This forces a read-only check first.
const RESUME_GUARDRAIL = 'You were interrupted mid-task and resumed. Before re-running ANY command with '
  + 'side effects (git push, deploy, file writes), FIRST verify via a read-only check (git status/log, '
  + 'file mtime, log tail) whether it already completed. Do NOT blindly re-run a mutating command just '
  + 'because you don\'t see its result.';

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

// acquireLock(id, home, io) -> release() | null. The per-workspace-id lock,
// via the shared primitive companion/lib/lock.js (write-then-link publish with
// an O_EXCL fallback, mtime torn-read guard, rename-aside token-verified
// reclaim, token-checked release — the design first built here, see lock.js's
// header for the incidents behind each piece). Policy unchanged: steal iff the
// holder pid is dead OR the lock is older than LOCK_STALE_MS; a live, fresh
// holder is respected -> null (caller aborts rather than double-resume).
//
// LOCK_SCRATCH_STALE_MS — how old an orphaned lock.js scratch file
// (LOCK_SCRATCH_RE below) must be before doctor --repair's sweep will remove it.
// Both are normally cleaned up inline by lock.js; this is only the backstop
// for a crash/kill between "create" and "cleanup" -- 15 minutes, same horizon
// as LOCK_STALE_MS itself, so nothing from an in-flight acquire is touched.
const LOCK_SCRATCH_STALE_MS = 15 * 60 * 1000;

function acquireLock(id, home, io) {
  const h = lockLib.acquire(lockPathFor(id, home), {
    fs: io && io.fs,
    isAlive: (io && io.isAlive) || defaultIsAlive,
    now: io && io.now,
    staleMs: LOCK_STALE_MS,
    liveStaleMs: LOCK_STALE_MS,
    stealDead: true,
  });
  return h ? function release() { h.release(); } : null;
}

// LOCK_SCRATCH_RE — lock.js's own scratch names, and nothing else:
//   <lock>.tmp-<pid>-<rand>   write-then-publish temp
//   <lock>.reap-<pid>-<rand>  rename-aside reclaim copy
//   <lock>.hb.<pid>-<rand>    refresh() tmp+rename temp
//   <lock>.reclaim            the reclaim sidecar (plus its own tmp/reap)
const LOCK_SCRATCH_RE = /\.lock\.(?:reclaim\.)?(?:tmp|reap|hb)[-.]|\.lock\.reclaim$/;

// lockScratchDirs(home) -> every directory a migrated lock.js caller keeps a
// lock in: devswarm/locks/ (recovery, supervisor, migrate, pull, retention,
// ingest, wake-watch), ~/.anti-hall/ (settings, repair-on-reload,
// swarm-guard), ~/.anti-hall/logs/ (log rotation; an ANTI_HALL_LOG_DIR
// override is not home-scoped and is not swept) and each
// devswarm/store/<hash>/journal/ (store journal locks).
function lockScratchDirs(home, F) {
  const ah = path.dirname(devswarmRoot(home)); // ~/.anti-hall
  const dirs = [path.join(devswarmRoot(home), 'locks'), ah, path.join(ah, 'logs')];
  const storeRoot = path.join(devswarmRoot(home), 'store');
  let hashes = [];
  try { hashes = F.readdirSync(storeRoot); } catch (_) { hashes = []; }
  for (const h of hashes) dirs.push(path.join(storeRoot, h, 'journal'));
  return dirs;
}

// sweepStaleLockScratchFiles(home, { dryRun, now, io }) -> { pending, detail,
// swept: [path,...] }. doctor --repair AUTO-SAFE backstop: removes lock.js
// scratch files (LOCK_SCRATCH_RE) older than LOCK_SCRATCH_STALE_MS from every
// lock directory (lockScratchDirs). All are normally self-cleaning; this only
// ever touches leftovers from a crash/kill mid-acquire/refresh/reclaim, once
// they are unambiguously old enough that no in-flight operation could still
// own them. Read-only when dryRun; never touches an actual `<name>.lock` file
// (those are covered by lock.js's own dead/stale-holder logic) or any file not
// matching LOCK_SCRATCH_RE. `detail` names every file removed (the doctor
// report is the log).
function sweepStaleLockScratchFiles(home, opts) {
  const o = opts || {};
  const F = (o.io && o.io.fs) || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const base = path.dirname(devswarmRoot(home));
  const stale = [];
  let seen = 0;
  for (const dir of lockScratchDirs(home, F)) {
    let entries;
    try { entries = F.readdirSync(dir); } catch (_) { continue; }
    seen++;
    for (const name of entries) {
      if (!LOCK_SCRATCH_RE.test(name)) continue;
      const full = path.join(dir, name);
      let st = null;
      try { st = F.statSync(full); } catch (_) { continue; }
      if (!st || (typeof st.isFile === 'function' && !st.isFile())) continue;
      if (Number.isFinite(st.mtimeMs) && (now - st.mtimeMs) > LOCK_SCRATCH_STALE_MS) stale.push(full);
    }
  }
  if (!seen) return { pending: false, detail: 'no lock dirs', swept: [] };
  const swept = [];
  if (!o.dryRun) {
    for (const full of stale) { try { F.unlinkSync(full); swept.push(full); } catch (_) { /* best-effort */ } }
  }
  const list = stale.length ? ': ' + stale.map((full) => path.relative(base, full)).join(', ') : '';
  return {
    pending: stale.length > 0,
    detail: stale.length + ' stale lock scratch file(s)' + list,
    swept: o.dryRun ? stale : swept,
  };
}

function readRecoveries(id, home, F) {
  try { return JSON.parse(F.readFileSync(livenessPathFor(id, home), 'utf8')).recoveries || 0; } catch (_) { return 0; }
}

// PRESERVED_VERDICT_FIELDS — cross-cutting fields shared by BOTH persist paths
// below. persistVerdict (recover()'s on-demand bookkeeping) and
// persistNudgeVerdict (pokeOrEscalate's automatic-sweep bookkeeping) write the
// SAME liveness file, so each call must carry forward the FULL UNION from
// `prev` — not just the field(s) it owns — or an interleaved sweep silently
// resets the OTHER path's counter (e.g. a nudge verdict wiping out the
// recovery cap, defeating the "cap at N recoveries" invariant).
const PRESERVED_VERDICT_FIELDS = ['recoveries', 'recoveredAt', 'nudgeAttempts', 'nudgedAt', 'staleSince', 'lastOutboundTs'];

// mergeVerdict(id, home, F, status, extra) -> verdict object. Reads the prior
// verdict (if any), carries forward the full PRESERVED_VERDICT_FIELDS union,
// then applies `extra` to override only the field(s) THIS call actually
// changed. Shared by persistVerdict and persistNudgeVerdict so neither can drop
// a field the other path owns.
function mergeVerdict(id, home, F, status, extra) {
  const preserved = { recoveries: 0, recoveredAt: null, nudgeAttempts: 0, nudgedAt: null, staleSince: null, lastOutboundTs: null };
  try {
    const prev = JSON.parse(F.readFileSync(livenessPathFor(id, home), 'utf8'));
    if (prev) {
      for (const key of PRESERVED_VERDICT_FIELDS) {
        if (prev[key] != null) preserved[key] = prev[key];
      }
    }
  } catch (_) {}
  return Object.assign({ status }, preserved, extra || {});
}

// persistVerdict — recover()'s own bookkeeping (status + recoveries/recoveredAt),
// via the shared mergeVerdict helper so nudgeAttempts/nudgedAt from the
// automatic sweep are never dropped.
function persistVerdict(descriptor, home, F, status, extra) {
  const v = mergeVerdict(descriptor.id, home, F, status, extra);
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

// defaultReconfirm(target, descriptor, selfPid, allowInteractive) -> bool. Fresh
// re-derivation via verifyTarget using the real ps/lsof runners (a hung probe is
// bounded inside the runner). Returns true iff the SAME pid+uuid is still the
// sole confirmed target. allowInteractive must match whatever findTarget used to
// ORIGINALLY confirm this target (the CLI's interactive-allowing lookup), else a
// legitimate interactive target would fail its own TOCTOU reconfirm.
function defaultReconfirm(target, descriptor, selfPid, allowInteractive) {
  return verifyTarget({
    worktreePath: descriptor.worktreePath,
    sessionId: descriptor.sessionId,
    pid: target.pid,
    uuid: target.uuid,
    selfPid,
    allowInteractive,
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
  const allowInteractive = !!opts.allowInteractive;
  const target = opts.target;
  const reconfirm = io.reconfirm || ((t) => defaultReconfirm(t, descriptor, selfPid, allowInteractive));

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

      // Resume headless (DETACHED) from the same cwd; feed the unread backlog,
      // with the state-check guardrail PREPENDED (see RESUME_GUARDRAIL header).
      const backlog = unreadBacklog(descriptor.inboxPath, descriptor.cursorPath, F);
      const prompt = RESUME_GUARDRAIL + '\n\n' + backlog.lines.join('\n');
      const res = (io.spawnResume || defaultSpawnResume)({ uuid: target.uuid, cwd: descriptor.worktreePath, prompt });
      const combined = String((res && res.output) || '') + String((res && res.stdout) || '') + String((res && res.stderr) || '');

      if (/No conversation found/i.test(combined)) {
        appendLog(home, { id: descriptor.id, action: 'escalate', reason: 'no-conversation-found', uuid: target.uuid }, F);
        persistVerdict(descriptor, home, F, 'escalated');
        return { action: 'escalate', reason: 'no-conversation-found' };
      }

      // Resume launched. It runs INDEPENDENTLY — its true liveness is unknown until
      // the next automatic sweep recomputes it from real signals, so record
      // 'recovering' (+recoveredAt) and increment the counter. NEVER a false
      // 'alive' from an unconfirmed resume.
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

// persistNudgeVerdict — the AUTOMATIC path's own bookkeeping (status +
// nudgeAttempts/nudgedAt), via the shared mergeVerdict helper so
// recoveries/recoveredAt from recover()'s on-demand kill path are never
// dropped.
function persistNudgeVerdict(descriptor, home, F, status, extra) {
  const v = mergeVerdict(descriptor.id, home, F, status, extra);
  try { writeVerdict(descriptor.id, v, home, F); } catch (_) {}
  return v;
}

// defaultFireCommand(argv) -> void. Fires a descriptor-supplied argv verbatim,
// detached + unref'd, best-effort (no output captured — this is a one-way poke/
// escalate signal, not a probe). A missing/empty argv is a silent no-op.
function defaultFireCommand(argv) {
  const a = Array.isArray(argv) ? argv : [];
  if (!a.length) return;
  try {
    const child = spawn(a[0], a.slice(1), { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (_) {}
}

function defaultOpenParentStore(opts) { return devswarmStore.openStore(opts); }

// safeRepoKey(worktree) -> the v0.57 mesh per-project store key, or null. Mirrors
// devswarm-ingest.js's own fail-open wrapper (devswarm-ingest.js:1526-1528): any
// resolution failure (non-git worktree, missing git binary, deleted path) is null,
// NEVER a throw — callers treat null as "mesh dormant" and fall back to the
// pre-mesh legacy behavior.
// Also null when the D27-guarded require above failed entirely.
function safeRepoKey(worktree) {
  try {
    return repokey && typeof repokey.repoKeyForWorktree === 'function'
      ? repokey.repoKeyForWorktree(worktree) : null;
  } catch (_) { return null; }
}

// notifyParentEscalation(descriptor, verdict, opts, openParentStore) — MECHANICALLY
// appends a synthetic notice into the PARENT/Primary's store (owner principle #20:
// the supervisor actively escalates into the parent's STORE, not just a local log,
// so an idle parent learns without taking a turn). Resolves the parent workspaceId
// by FIRST resolving the MAIN worktree via install-devswarm-ingest.js's
// resolveMainWorktree(worktreePath), THEN hashing that via primaryWorkspaceId()
// (`primary-<hash>`, per-worktree, no collisions across repos) — the SAME id the
// Primary reads via `devswarm inbox messages`/`read-primary`.
//
// IDEMPOTENT (belt-and-suspenders, two layers):
//   1. Caller-gated: only invoked on the verdict TRANSITION into escalated (the
//      caller checks `wasEscalated` before calling this at all — see pokeOrEscalate
//      below). Also naturally gated by liveness.js's terminal short-circuit: once a
//      workspace verdict persists 'escalated', computeLiveness stops returning
//      'stale', so the AUTOMATIC sweep's `verdict.status === 'stale'` gate never
//      calls pokeOrEscalate again for that workspace.
//   2. Store-level hash dedupe: the appended message carries a stable per-escalation
//      hash (`escalate:<childId>:<staleSince>`) so a genuine race between two
//      processes both observing a pre-transition verdict still lands only one row
//      (both backends' appendMessage dedupe by hash).
// PROJECTION: the append is followed by a deriveSummary on the SAME handle — see the
// inline note at the call site for why `workspaceId` must be omitted from its opts.
// FAIL-OPEN: any error (unreadable worktree, unopenable store, fs failure) is
// swallowed — a parent-notice failure must NEVER crash the sweep or block the
// (already-persisted) escalation itself.
function notifyParentEscalation(descriptor, verdict, opts, openParentStore) {
  try {
    if (!descriptor || !descriptor.worktreePath) return;
    const home = opts && opts.home;
    const now = Number.isFinite(opts && opts.now) ? opts.now : Date.now();
    // ADDRESSEE FIX: primaryWorkspaceId() is a PURE HASH of the path it is handed — it
    // performs no git resolution. descriptor.worktreePath is the CHILD's own worktree
    // root (findGitToplevel stops at the linked worktree, whose `.git` is a FILE, not a
    // dir), so hashing it yielded the CHILD'S OWN mesh id and the notice was filed into
    // a queue the parent never reads. resolveMainWorktree() resolves via git-common-dir,
    // which is identical for every worktree of a project, so this yields the real
    // Primary's id. FAIL-OPEN: null (non-git worktree, or the D27-guarded repokey module
    // unavailable) falls back to the previous behavior — MEASURED: resolveMainWorktree
    // returns null on a non-git path, so pre-existing non-git test fixtures are
    // unaffected by construction.
    const parentWorktree = resolveMainWorktree(descriptor.worktreePath) || descriptor.worktreePath;
    const parentId = primaryWorkspaceId(parentWorktree);
    if (!isSafeId(parentId) || parentId === descriptor.id) return; // never notify self
    const staleSince = Number.isFinite(verdict && verdict.staleSince) ? verdict.staleSince : null;
    const idleMin = staleSince !== null ? Math.max(0, Math.round((now - staleSince) / 60000)) : null;
    const body = 'child ' + descriptor.id + ' idle' + (idleMin !== null ? ' ' + idleMin + 'm' : '')
      + ' — reassign or archive';
    // PER-PROJECT: the notice lands in the PARENT's own repoKey store (the key every
    // other mesh writer opens with — never the legacy hashFromWorkspaceId bucket),
    // and deliverEscalation re-derives THAT store's projection (no workspaceId in
    // the derive opts, so summaries/<repoKey>.json — see devswarm-migrate.js:706-716).
    const intent = {
      childId: descriptor.id, parentId, repoKey: safeRepoKey(descriptor.worktreePath) || null,
      row: { workspaceId: parentId, ts: now, hash: 'escalate:' + descriptor.id + ':' + (staleSince !== null ? staleSince : 'x'), body },
    };
    deliverEscalation(intent, { home, now, env: opts && opts.env, fsi: opts && opts.fsi }, openParentStore);
  } catch (_) { /* fail-open: a store-write error must never crash the sweep */ }
}

// The escalation notice is ONE-SHOT (sent on the transition to `escalated`), so a
// delivery that cannot land now must be RETRIED, never dropped. It goes through
// devswarm.js appendIntoPartition (the parent's lock + "parent still registered
// in this store" recheck, like every write into a partition we do not own). On
// busy/gone — or any store error — the intent is persisted at
// escalation-pending/<childId>.json and re-attempted by the next pokeOrEscalate
// for that child; a delivered intent is overwritten with delivered:true (never
// deleted). Returns 'ok' | 'busy' | 'gone' | 'error'.
function escalationIntentPath(home, childId) {
  return path.join(devswarmRoot(home), 'escalation-pending', String(childId) + '.json');
}
function writeEscalationIntent(home, intent, F) {
  try {
    const p = escalationIntentPath(home, intent.childId);
    F.mkdirSync(path.dirname(p), { recursive: true });
    F.writeFileSync(p, JSON.stringify(intent));
  } catch (_) { /* best-effort */ }
}
function readEscalationIntent(home, childId, F) {
  try {
    const it = JSON.parse((F || fs).readFileSync(escalationIntentPath(home, childId), 'utf8'));
    return it && !it.delivered && it.row && it.parentId ? it : null;
  } catch (_) { return null; }
}
function deliverEscalation(intent, o, openParentStore) {
  const home = o.home;
  const F = o.fsi || fs;
  let status = 'error';
  try {
    const open = openParentStore || defaultOpenParentStore;
    const s = open({ home, workspaceId: intent.parentId, hash: intent.repoKey || undefined, env: o.env, fsi: o.fsi });
    try {
      const dw = require('../../scripts/devswarm.js');
      status = dw.appendIntoPartition(s, home, intent.parentId, [intent.row], { via: 'message' }).status;
      if (status === 'ok') { try { devswarmStore.deriveSummary(s, { home, env: o.env, now: o.now, fsi: o.fsi }); } catch (_) {} }
    } finally { s.close(); }
  } catch (_) { status = 'error'; }
  if (status === 'ok') {
    if (readEscalationIntent(home, intent.childId, F)) writeEscalationIntent(home, Object.assign({}, intent, { delivered: true, deliveredAt: o.now }), F);
  } else {
    writeEscalationIntent(home, Object.assign({}, intent, { lastStatus: status, lastAttemptAt: o.now }), F);
  }
  return status;
}

// listEscalationIntents(home, F) -> [intent] — every escalation-pending/<childId>.json
// that parses (delivered tombstones included; callers filter on `delivered`). One
// file per child id, overwritten in place: storage is bounded by the child count
// and NOTHING here is ever deleted automatically (audit trail).
function listEscalationIntents(home, F) {
  const FS = F || fs;
  const dir = path.join(devswarmRoot(home), 'escalation-pending');
  let names = [];
  try { names = FS.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    try {
      const it = JSON.parse(FS.readFileSync(path.join(dir, n), 'utf8'));
      if (it && it.parentId && it.row) out.push(it);
    } catch (_) { /* unreadable intent: surfaced by doctor's count as unparsable is out of scope; skip */ }
  }
  return out;
}
// drainEscalationIntents(home, opts, openParentStore) -> { attempted, delivered, pending }.
// Called by EVERY supervisor sweep, independent of any child's liveness status (an
// `escalated` child is sticky and no longer reaches pokeOrEscalate).
function drainEscalationIntents(home, opts, openParentStore) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const out = { attempted: 0, delivered: 0, pending: 0 };
  for (const it of listEscalationIntents(home, o.fsi)) {
    if (it.delivered) continue;
    out.attempted++;
    const st = deliverEscalation(it, { home, now, env: o.env, fsi: o.fsi }, openParentStore);
    if (st === 'ok') out.delivered++; else out.pending++;
  }
  return out;
}
// escalationIntentStats(home, now) -> { undelivered, delivered, oldestUndeliveredAgeMs,
//   oldestDeliveredAgeMs, undeliveredIds } — doctor's read-only view.
function escalationIntentStats(home, now, F) {
  const t = Number.isFinite(now) ? now : Date.now();
  const all = listEscalationIntents(home, F);
  const age = (x) => (Number.isFinite(x) ? Math.max(0, t - x) : null);
  const und = all.filter((i) => !i.delivered);
  const del = all.filter((i) => i.delivered);
  const oldest = (arr, at) => arr.reduce((m, i) => { const a = age(at(i)); return a != null && (m == null || a > m) ? a : m; }, null);
  return {
    undelivered: und.length, delivered: del.length,
    oldestUndeliveredAgeMs: oldest(und, (i) => i.row && i.row.ts),
    oldestDeliveredAgeMs: oldest(del, (i) => i.deliveredAt),
    undeliveredIds: und.map((i) => ({ childId: i.childId, parentId: i.parentId, lastStatus: i.lastStatus || null })),
  };
}
// parkedEscalationSegment(home, parentId, cliPath) -> string | null. The Primary's
// per-turn injection and its Stop gate both render THIS text for the undelivered
// intents addressed to it, so the two surfaces can never disagree.
function parkedEscalationSegment(home, parentId, cliPath, F) {
  if (!parentId) return null;
  const mine = listEscalationIntents(home, F).filter((i) => !i.delivered && String(i.parentId) === String(parentId));
  if (!mine.length) return null;
  const kids = mine.map((i) => i.childId).sort();
  return 'DEVSWARM ESCALATIONS NOT DELIVERED (' + mine.length + '): the supervisor escalated '
    + kids.map((k) => JSON.stringify(k)).join(', ')
    + ' (idle — reassign or archive), but this Primary (' + parentId + ') is not registered in the mesh store'
    + ' (or its lock was busy), so the notice is PARKED. Run `node ' + (cliPath || 'scripts/devswarm.js')
    + ' register-primary` — the next supervisor sweep then delivers it.';
}

// pokeOrEscalate(descriptor, verdict, opts, io) -> { action: 'nudged'|'escalate'|'error' }.
// Called by the AUTOMATIC sweep on a `stale` verdict. NEVER kills, NEVER resolves
// a pid — see the module header. Exactly two outcomes:
//   - nudge: descriptor has a nudgeCommand, attempts remain, and the per-attempt
//     cooldown has elapsed -> fire nudgeCommand, persist 'nudged' + bump attempts.
//   - escalate: attempts exhausted, still cooling down, or no nudgeCommand at
//     all -> log + persist 'escalated', firing descriptor.escalateCommand once
//     if present, AND (on the actual transition into escalated) mechanically
//     notifying the parent's store via notifyParentEscalation above. A human must
//     look; the sweep will not retry (escalated is terminal — see liveness.js's
//     short-circuit).
function pokeOrEscalate(descriptor, verdict, opts, io) {
  const o = opts || {};
  const IO = io || {};
  const home = o.home || os.homedir();
  const F = IO.fs || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const maxAttempts = Number.isFinite(o.nudgeMaxAttempts) ? o.nudgeMaxAttempts : DEFAULT_NUDGE_MAX_ATTEMPTS;
  const cooldownMs = Number.isFinite(o.nudgeCooldownMs) ? o.nudgeCooldownMs : DEFAULT_NUDGE_COOLDOWN_MS;
  const nudge = IO.nudge || defaultFireCommand;
  const escalate = IO.escalate || defaultFireCommand;
  const openParentStore = IO.openParentStore;

  try {
    // A previously undeliverable escalation notice is retried FIRST (one-shot
    // transition -> it would otherwise never be re-sent).
    const pendingIntent = readEscalationIntent(home, descriptor.id, F);
    if (pendingIntent) deliverEscalation(pendingIntent, { home, now, env: o.env, fsi: F }, openParentStore);
    const attempts = Number.isFinite(verdict && verdict.nudgeAttempts) ? verdict.nudgeAttempts : 0;
    const nudgedAt = Number.isFinite(verdict && verdict.nudgedAt) ? verdict.nudgedAt : null;
    const cooldownElapsed = nudgedAt === null || (now - nudgedAt) >= cooldownMs;

    if (descriptor.nudgeCommand && attempts < maxAttempts && cooldownElapsed) {
      try { nudge(descriptor.nudgeCommand); } catch (_) {}
      appendLog(home, { id: descriptor.id, action: 'nudged', attempt: attempts + 1 }, F);
      persistNudgeVerdict(descriptor, home, F, 'nudged', { nudgeAttempts: attempts + 1, nudgedAt: now });
      return { action: 'nudged', attempt: attempts + 1 };
    }

    // Exhaustion (attempts used up / still cooling down out of budget) or no
    // nudgeCommand at all -> escalate. NEVER a kill.
    const wasEscalated = !!(verdict && verdict.status === 'escalated');
    appendLog(home, { id: descriptor.id, action: 'escalate', reason: 'poke-exhausted' }, F);
    persistNudgeVerdict(descriptor, home, F, 'escalated', {});
    if (descriptor.escalateCommand) { try { escalate(descriptor.escalateCommand); } catch (_) {} }
    // Only on the TRANSITION into escalated — never re-notify an already-escalated
    // workspace on a repeated call (e.g. a manual `devswarm nudge` re-invoked, or a
    // stray sweep tick before liveness.js's terminal short-circuit takes effect).
    if (!wasEscalated) {
      notifyParentEscalation(descriptor, verdict, { home, now, env: o.env, fsi: F }, openParentStore);
    }
    return { action: 'escalate', reason: 'poke-exhausted' };
  } catch (e) {
    appendLog(home, { id: descriptor && descriptor.id, action: 'error', reason: String(e && e.message) }, F);
    return { action: 'error', reason: String(e && e.message) };
  }
}

module.exports = {
  DEFAULT_MAX_RECOVERIES, DEFAULT_GRACE_MS, DEFAULT_NUDGE_MAX_ATTEMPTS, DEFAULT_NUDGE_COOLDOWN_MS,
  RESUME_GUARDRAIL, LOCK_STALE_MS, LOCK_SCRATCH_STALE_MS,
  lockPathFor, recoveryLogPath, acquireLock, sweepStaleLockScratchFiles, recover, pokeOrEscalate, notifyParentEscalation,
  escalationIntentPath, readEscalationIntent, listEscalationIntents, drainEscalationIntents,
  escalationIntentStats, parkedEscalationSegment,
};
