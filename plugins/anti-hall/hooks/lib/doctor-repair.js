'use strict';
// anti-hall :: doctor-repair — the REPAIR half of doctor.js as a pure, testable
// module (mirrors companion/lib/doctor-devswarm.js's require-and-call pattern).
//
// doctor.js diagnoses; this module FIXES. Plain `node doctor.js` (and --fix /
// --repair / --dry-run) call runRepairs() after the diagnostic sections; --check
// skips it entirely (pure read-only, the CI/test path).
//
// Two safety classes:
//   AUTO-SAFE — always applied (honoring dryRun): legacy/GSD/DevSwarm-store
//     migration, statusline-if-missing (never overriding a custom statusLine),
//     supervisor idempotent relaunch when ALREADY installed, codex hook refresh
//     when a <scope>/.codex/config.toml exists but the hooks are unwired.
//   GATED — applied only when isDevswarmActive(env) AND resolveWorktree(cwd) is a
//     real git worktree: ingest daemon install / wrong-path rebind / stale-script /
//     unstable-script (config drift — the baked ExecStart script still exists but is
//     no longer the current stable marketplace-clone path; see resolveStableScript in
//     install-devswarm-ingest.js and classifyIngestUnit below), and supervisor
//     FIRST-install. Gate-fail → status 'gated' + the exact manual command, never a
//     mutation. This mirrors (and is reused by) skills/update/scripts/update.js's own
//     healIngestDaemon — same classify helpers, same gate — so `doctor --repair` and
//     `update` migrate a drifted/misconfigured unit the identical way.
//   REPORT-ONLY — reaper missing (it kills orphans on a timer; never auto-installed).
//
// Every fix is wrapped try/catch and FAILS OPEN (a raised fix becomes one
// status:'failed' entry and never aborts the pass). After a real fix, the relevant
// detection is RE-RUN to confirm it actually took (a spawned installer's exit code
// is not trusted — launchctl load can warn) before reporting 'fixed'.
//
// Pure Node built-ins, cross-platform. Windows daemon fixes are documented no-ops.

const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..'); // hooks/lib -> plugin root

const INGEST_INSTALLER     = path.join(PLUGIN_ROOT, 'companion', 'install-devswarm-ingest.js');
const INGEST_DAEMON        = path.join(PLUGIN_ROOT, 'companion', 'devswarm-ingest.js');
const DEVSWARM_REPOKEY     = path.join(PLUGIN_ROOT, 'companion', 'lib', 'devswarm-repokey.js');
const SUPERVISOR_INSTALLER = path.join(PLUGIN_ROOT, 'companion', 'install-devswarm-supervisor.js');
const REAPER_INSTALLER     = path.join(PLUGIN_ROOT, 'companion', 'install-reaper.js');
const STATUSLINE_INSTALLER = path.join(PLUGIN_ROOT, 'statusline', 'install-statusline.js');
const CODEX_INSTALLER      = path.join(PLUGIN_ROOT, 'codex', 'install-codex.js');
const MIGRATE_STATE        = path.join(PLUGIN_ROOT, 'scripts', 'migrate-state.js');
const DEVSWARM_SCRIPT      = path.join(PLUGIN_ROOT, 'scripts', 'devswarm.js');
const DEVSWARM_STORE       = path.join(PLUGIN_ROOT, 'companion', 'lib', 'devswarm-store.js');

// v0.57 mesh Phase 6 (D9/D25/D28) — belt-and-suspenders orphan sweep for LEGACY
// per-worktree ingest units. A legacy unit's heartbeat/lock are keyed by its own
// hash; the per-project daemon it may now be redundant with is keyed by repoKey —
// both are read via the companion modules below, NEVER re-derived here (same
// discipline as ingestConst() above).
function ingestDaemonMod() {
  try { return require(INGEST_DAEMON); } catch (_) { return {}; }
}
function repokeyMod() {
  try { return require(DEVSWARM_REPOKEY); } catch (_) { return {}; }
}
// B2: lazy require of the ONE shared health definition (companion/lib/
// ingest-health.js) — see projectDaemonHealthy below for why this replaced a
// locally-duplicated, WEAKER check.
function ingestHealthMod() {
  try { return require(path.join(PLUGIN_ROOT, 'companion', 'lib', 'ingest-health.js')); } catch (_) { return {}; }
}
function devswarmRootFor(home) {
  try { return require(path.join(PLUGIN_ROOT, 'companion', 'lib', 'liveness.js')).devswarmRoot(home); } catch (_) { return path.join(home, '.anti-hall', 'devswarm'); }
}
// Lazy require of companion/lib/doctor-devswarm.js — reused ONLY for its
// wakeMonitorShipped/wakeMonitorLiveCheck helpers (see the wake-monitor
// REPORT-ONLY block in runRepairs below) so the repair-pass report can never
// drift from the doctor-diagnostic verdict computed the same way.
function doctorDevswarmMod() {
  try { return require(path.join(PLUGIN_ROOT, 'companion', 'lib', 'doctor-devswarm.js')); } catch (_) { return {}; }
}
// projectDaemonHealthy(home, repoKey, now, io) -> bool.
//
// B2 FIX: this used to be a LOCALLY-DUPLICATED, WEAKER reimplementation of
// companion/lib/ingest-health.js's own daemonHealth() — it lacked BOTH the
// same-incarnation pid guard (a fresh heartbeat from a PRIOR daemon incarnation
// plus a live lock held by a DIFFERENT, newer incarnation used to read as
// "healthy" here even though neither signal was ever checked against the
// other) AND the v0.66 monitor-outcome-fault check (a daemon that is alive and
// heartbeating but whose every `hivecontrol workspace monitor` spawn is
// failing — see monitorFaultFor below — used to read as "healthy" here too).
// ingest-health.js's own header comment explicitly promises every consumer
// agrees on ONE definition of "the daemon is alive"; this function was the one
// consumer that did not. reapOrphanedLegacyUnits (below) trusts a `true` here
// to justify REAPING a legacy unit as "redundant" — a false-positive healthy
// verdict there authorizes stopping the sole real drainer for that repo.
//
// Now a thin delegate: ONLY `status === 'healthy'` from the shared
// daemonHealth() counts. Fail-open unchanged (any read/require error -> false,
// never a confident "healthy").
function projectDaemonHealthy(home, repoKey, now, io) {
  if (!repoKey) return false;
  try {
    const health = ingestHealthMod();
    if (typeof health.daemonHealth !== 'function') return false;
    const result = health.daemonHealth(home, repoKey, { now, io });
    return !!(result && result.status === 'healthy');
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// v0.66 MONITOR-OUTCOME FAULT (the "alive but ingesting nothing" case)
// ---------------------------------------------------------------------------
// projectDaemonHealthy above answers "is a process alive and heartbeating" — it
// CANNOT answer "is that process actually draining anything". The field defect:
// the daemon wrote its heartbeat unconditionally BEFORE each monitor call, so a
// daemon whose every `hivecontrol workspace monitor` spawn failed ENOENT (bare
// binary name + the scheduler's minimal PATH) heartbeat happily forever and
// doctor reported it "installed and healthy" while it ingested exactly nothing.
//
// The daemon now stamps its monitor OUTCOME into the same heartbeat
// (consecutiveMonitorFailures / lastMonitorOkMs / lastMonitorErrorCode /
// hivecontrolBin / daemonPath — see devswarm-ingest.js writeIngestHeartbeat).
//
// FAIL-OPEN ON LEGACY: a heartbeat WITHOUT these fields (a daemon from an older
// build that has not been relaunched yet) is UNKNOWN, never a fault. Only a
// POSITIVE, above-threshold failure count — or a positively stale last-success
// alongside a recorded failure — is ever reported.
const MONITOR_FAILURE_FAIL_THRESHOLD = 3;      // consecutive failures before this is a FAULT, not a blip
const MONITOR_OK_STALE_MS = 10 * 60 * 1000;    // a recorded last-success older than this, while failing, is also a fault

// monitorFaultFor(home, repoKey, now, io) -> null | {consecutive, code, bin, daemonPath, lastOkMs, reason}
// Pure fs, never throws, null on ANY doubt (missing file, unparsable JSON,
// missing fields, below threshold).
function monitorFaultFor(home, repoKey, now, io) {
  if (!repoKey) return null;
  const F = (io && io.fs) || fs;
  const daemon = ingestDaemonMod();
  if (typeof daemon.ingestHeartbeatPath !== 'function') return null;
  let beat = null;
  try { beat = JSON.parse(F.readFileSync(daemon.ingestHeartbeatPath(home, repoKey), 'utf8')); } catch (_) { return null; }
  if (!beat || typeof beat !== 'object') return null;
  // LEGACY GUARD: the field must be PRESENT and numeric. `undefined` (older
  // daemon) is unknown -> never a fault.
  if (!Number.isFinite(beat.consecutiveMonitorFailures)) return null;
  const consecutive = beat.consecutiveMonitorFailures;
  const lastOkMs = Number.isFinite(beat.lastMonitorOkMs) ? beat.lastMonitorOkMs : null;
  const okStale = consecutive > 0 && lastOkMs !== null && (now - lastOkMs) > MONITOR_OK_STALE_MS;
  if (consecutive < MONITOR_FAILURE_FAIL_THRESHOLD && !okStale) return null;
  return {
    consecutive,
    code: typeof beat.lastMonitorErrorCode === 'string' ? beat.lastMonitorErrorCode : null,
    error: typeof beat.lastMonitorError === 'string' ? beat.lastMonitorError : null,
    bin: typeof beat.hivecontrolBin === 'string' ? beat.hivecontrolBin : null,
    binSource: typeof beat.hivecontrolSource === 'string' ? beat.hivecontrolSource : null,
    daemonPath: typeof beat.daemonPath === 'string' ? beat.daemonPath : null,
    lastOkMs,
    okStale,
  };
}

// monitorFaultReason(fault) -> the operator-facing FAILURE line. Names the
// resolved binary, the daemon's ACTUAL inherited PATH when the daemon recorded
// one, and the remedy (which is exactly what the reinstall below performs).
function monitorFaultReason(fault, workingDir) {
  const f = fault || {};
  return 'ingest daemon is RUNNING but its `hivecontrol workspace monitor` calls are FAILING ('
    + f.consecutive + ' consecutive' + (f.code ? ', ' + f.code : '')
    + (f.lastOkMs === null ? ', no successful poll since start' : (f.okStale ? ', last success ' + Math.round((Date.now() - f.lastOkMs) / 60000) + 'm ago' : ''))
    + ') — it is alive but ingesting NOTHING'
    + '. binary=' + (f.bin || 'hivecontrol') + (f.binSource ? ' (' + f.binSource + ')' : '')
    + (f.daemonPath ? '; daemon PATH=' + f.daemonPath : '')
    + (workingDir ? '; WorkingDirectory ' + workingDir : '')
    + '. Reinstalling bakes the resolved absolute binary + PATH into the scheduler unit; or export '
    + 'ANTIHALL_DEVSWARM_HIVECONTROL=/absolute/path/to/hivecontrol and reinstall.';
}

// ---------------------------------------------------------------------------
// v0.65.0 `doctor --reclaim-ingest-lock` (explicit, opt-in, human-invoked —
// mirrors devswarm-recover being on-demand only). Field evidence: 52 dead-owner
// ingest locks where a plain reinstall NEVER cleared the lock, because
// devswarm-ingest.js's own acquireIngestLock() correctly REFUSES to reclaim a
// lock whose recorded pid reads as "alive" — and a pid that has been REUSED by
// an unrelated live process (the original ingest daemon died; the OS later
// handed that same pid number to a shell/editor/other session) reads as
// exactly that: alive. acquireIngestLock's fail-toward-never-kill posture is
// correct for its own AUTOMATIC callers (an ambiguous signal must never
// auto-reclaim) — but it means a pid-reuse-stuck lock, or one whose holder is a
// zombie/defunct process (still "alive" to kill(pid,0), never checked by
// acquireIngestLock at all), stays stuck FOREVER without a human explicitly
// authorizing the stronger check. This section adds exactly that check, gated
// behind the explicit --reclaim-ingest-lock flag ONLY (never wired into the
// default/auto repair pass in runRepairs above).
//
// Safety invariant (identical to the module's other lock-touching code): a
// lock file may be REMOVED only when its recorded pid is CONFIRMED dead,
// CONFIRMED a zombie/defunct process (still "exists" to kill(pid,0) but can
// never do anything again — only its parent can reap it, so it can never be
// the live original holder either), or CONFIRMED pid-reuse (its OS start time
// postdates the lock's own recorded ts — the ORIGINAL holder cannot have
// written this lock file with a pid that did not exist yet). A process is
// NEVER signalled here for any of those three cases (nothing alive needs
// killing to explain them). The one signal-capable case — a LIVE holder whose
// OWN heartbeat proves it is wedged — is handled by reusing
// devswarm-ingest.js's own acquireIngestLock() verbatim (never reimplemented),
// since that already SIGKILLs only after the same two-signal confirmation this
// file's safety contract requires. Any inconclusive read (missing pid, missing
// ts, an unresolvable start time) leaves the lock untouched — fail toward
// NEVER removing/signalling, matching every other lock-touching path here.
// ---------------------------------------------------------------------------

// isReclaimable(daemon, state) -> bool. devswarm-ingest.js's own classify
// states that authorize removal are 'dead' | 'reused' | 'zombie'
// (RECLAIMABLE_HOLDER_STATES) — prefers a real exported
// isReclaimableHolderState() the instant one exists, falling back to the same
// 3-state check here in the meantime (that build's own state-NAME contract is
// already something this file depends on regardless, e.g. the report
// messages below spell 'dead'/'reused'/'zombie'/'torn-stale' literally, so
// this adds no new coupling beyond what already exists).
// RECLAIM_WEDGE_GRACE_FALLBACK_MS / defaultReclaimSleep — see
// reclaimCurrentProjectLock's SLEEP/WAKE GRACE WINDOW comment below. `io.sleep`
// is a test-injection seam (mirrors io.fs/io.now elsewhere in this file);
// production has no override and gets a real synchronous wait. Mirrors
// devswarm-ingest.js's own sleepSync (Atomics.wait on a SharedArrayBuffer — no
// external deps, cross-platform).
function defaultReclaimSleep(ms) {
  try { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, Math.max(0, ms | 0)); } catch (_) {}
}
// Fallback only for a build whose devswarm-ingest.js does not export
// DEFAULT_MONITOR_TIMEOUT_SEC — kept in the same units/formula as that
// module's own hardTimeoutMs default (see reclaimCurrentProjectLock).
const RECLAIM_WEDGE_GRACE_FALLBACK_MS = 40000;

function isReclaimable(daemon, state) {
  if (daemon && typeof daemon.isReclaimableHolderState === 'function') {
    try { return !!daemon.isReclaimableHolderState(state); } catch (_) { /* fall through to the local check */ }
  }
  return state === 'dead' || state === 'reused' || state === 'zombie';
}

// listIngestLockFiles(home, F) -> absolute paths of every ingest lock file
// under the locks dir. Prefers devswarm-ingest.js's OWN ingestLocksDir() +
// INGEST_LOCK_NAME_RE (v0.65 daemon-reliability) for byte-identical matching —
// falls back to an equivalent local dir/regex only if that build predates
// those exports. Never matches an unrelated lock file. Fail-open: an
// unreadable/absent locks dir yields [].
function listIngestLockFiles(home, F) {
  const daemon = ingestDaemonMod();
  let dir = null;
  try { dir = typeof daemon.ingestLocksDir === 'function' ? daemon.ingestLocksDir(home) : null; } catch (_) { dir = null; }
  if (!dir) dir = path.join(devswarmRootFor(home), 'locks');
  const re = (daemon.INGEST_LOCK_NAME_RE instanceof RegExp) ? daemon.INGEST_LOCK_NAME_RE : /^ingest(-[^.]+)?\.lock$/;
  let names = [];
  try { names = F.readdirSync(dir); } catch (_) { return []; }
  return names.filter((n) => re.test(n)).map((n) => path.join(dir, n));
}

// sweepOrphanedIngestLockFiles({home, dryRun, io}) -> [{id, lockPath, verdict,
// status, msg}] status ∈ 'fixed' | 'skipped' | 'failed'. A thin doctor-report
// adapter over devswarm-ingest.js's OWN sweepOrphanedIngestLocks (v0.65
// daemon-reliability — classifyLockHolder + isReclaimableHolderState, bounded,
// anchored lock-name matching, structured logging) — the actual dead/reused/
// zombie/torn-stale decision and removal are REUSED VERBATIM, never
// reimplemented here. Machine-wide (every worktree/project's ingest lock, not
// just the caller's cwd — see reclaimIngestLocks below for the cwd-scoped
// counterpart that additionally handles the wedged-heartbeat+SIGKILL case).
// NEVER signals a process (neither this adapter nor the daemon's own sweep
// ever does). `--dry-run` has no non-destructive mode on the daemon side to
// call into (same precedent as this file's own reconcile dry-run), so it is
// previewed here via the same read-only classifyLockHolder the real sweep
// itself uses — never removes anything.
function sweepOrphanedIngestLockFiles(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const dryRun = !!o.dryRun;
  const io = o.io;
  const F = (io && io.fs) || fs;
  const now = (io && io.now) || Date.now;
  const daemon = ingestDaemonMod();
  if (typeof daemon.readLockHolder !== 'function' || typeof daemon.classifyLockHolder !== 'function') {
    return [{ id: 'reclaim-sweep', lockPath: null, verdict: null, status: 'failed', msg: 'devswarm-ingest.js does not export readLockHolder/classifyLockHolder in this build — cannot safely sweep, nothing touched' }];
  }

  if (!dryRun) {
    if (typeof daemon.sweepOrphanedIngestLocks !== 'function') {
      return [{ id: 'reclaim-sweep', lockPath: null, verdict: null, status: 'failed', msg: 'devswarm-ingest.js does not export sweepOrphanedIngestLocks in this build — cannot safely sweep, nothing touched' }];
    }
    let result = null;
    // allowTornStale: true — this whole call is reachable ONLY via the
    // explicit, human-invoked `doctor --reclaim-ingest-lock` flag (see
    // reclaimIngestLocks below), never from the automatic per-daemon-start
    // sweep (runIngestLoop omits this option entirely) — so a torn/zero-byte
    // lock with no provable holder identity may still be swept HERE under
    // explicit operator action, matching this feature's existing contract.
    try { result = daemon.sweepOrphanedIngestLocks(home, io, null, { allowTornStale: true }); } catch (e) {
      return [{ id: 'reclaim-sweep', lockPath: null, verdict: null, status: 'failed', msg: 'sweepOrphanedIngestLocks raised: ' + errMsg(e) }];
    }
    const out = [];
    for (const r of ((result && result.reaped) || [])) {
      out.push({ id: 'reclaim-sweep-' + path.basename(r.lockPath), lockPath: r.lockPath, verdict: r.reason, status: 'fixed', msg: 'reclaimed ' + r.lockPath + ' (' + r.reason + ')' });
    }
    if (result && Number.isFinite(result.kept) && result.kept > 0) {
      out.push({ id: 'reclaim-sweep-summary', lockPath: null, verdict: null, status: 'skipped', msg: result.kept + ' other ingest lock(s) kept — live/plausible or unconfirmable, left untouched' });
    }
    return out;
  }

  // --dry-run PREVIEW: read-only, mirrors the real sweep's own eligibility rule
  // (isReclaimableHolderState(state) OR state === 'torn-stale') without ever
  // calling the mutating sweepOrphanedIngestLocks.
  const results = [];
  for (const lockPath of listIngestLockFiles(home, F)) {
    const rid = 'reclaim-sweep-' + path.basename(lockPath);
    let holder = null;
    try { holder = daemon.readLockHolder(lockPath, F); } catch (e) {
      results.push({ id: rid, lockPath, verdict: null, status: 'failed', msg: lockPath + ' raised while reading: ' + errMsg(e) });
      continue;
    }
    if (!holder) continue; // genuinely absent (ENOENT) — nothing to report
    let cls = null;
    try { cls = daemon.classifyLockHolder(holder, now(), io); } catch (e) {
      results.push({ id: rid, lockPath, verdict: null, status: 'failed', msg: lockPath + ' raised while classifying: ' + errMsg(e) });
      continue;
    }
    const sweepable = isReclaimable(daemon, cls.state) || cls.state === 'torn-stale';
    if (!sweepable) {
      results.push({ id: rid, lockPath, verdict: null, status: 'skipped', msg: lockPath + ' kept — holder state "' + cls.state + '"' });
      continue;
    }
    results.push({ id: rid, lockPath, verdict: cls.state, status: 'skipped', msg: '[dry-run] would reclaim ' + lockPath + ' (' + cls.state + ')' });
  }
  return results;
}

// reclaimCurrentProjectLock({home, currentWorktree, dryRun, io}) -> {lockPath,
// verdict, status, msg}. The cwd-scoped counterpart to the sweep above.
// devswarm-ingest.js's own acquireIngestLock() (v0.65) now handles EVERY
// removal-authorizing case itself — dead / pid-reused / zombie (via
// classifyLockHolder, reclaimed immediately, no signal) AND a live holder
// confirmed WEDGED via its own stale heartbeat (SIGKILL, the one signal-
// capable case) — refusing only a genuinely live, healthy holder. So this
// function delegates the actual mutating decision to it ENTIRELY, never
// reimplementing any of that logic; it only reads the lock first (to report
// "nothing present" distinctly) and — for reporting/dry-run purposes only —
// previews the verdict via the same read-only classifyLockHolder.
function reclaimCurrentProjectLock(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const currentWorktree = o.currentWorktree;
  const dryRun = !!o.dryRun;
  const io = o.io;
  const F = (io && io.fs) || fs;
  const now = (io && io.now) || Date.now;
  const daemon = ingestDaemonMod();
  if (typeof daemon.ingestLockPath !== 'function' || typeof daemon.readLockHolder !== 'function') {
    return { lockPath: null, verdict: null, status: 'failed', msg: 'devswarm-ingest.js does not export ingestLockPath/readLockHolder in this build — cannot safely reclaim' };
  }
  const lockPath = daemon.ingestLockPath(home, currentWorktree);
  let holder = null;
  try { holder = daemon.readLockHolder(lockPath, F); } catch (e) {
    return { lockPath, verdict: null, status: 'failed', msg: lockPath + ' raised while reading: ' + errMsg(e) };
  }
  if (!holder) return { lockPath, verdict: null, status: 'skipped', msg: 'no ingest lock file present for this worktree (' + lockPath + ') — nothing to reclaim' };

  // Read-only preview of the verdict (never removes/signals anything itself) —
  // used for an accurate report message either way, and as the dry-run answer
  // for the dead/reused/zombie cases (the wedged-heartbeat case has no
  // non-mutating preview available — same precedent as the sweep above).
  let verdict = null;
  if (typeof daemon.classifyLockHolder === 'function') {
    try {
      const cls = daemon.classifyLockHolder(holder, now(), io);
      if (isReclaimable(daemon, cls.state)) verdict = cls.state;
    } catch (_) { verdict = null; }
  }

  if (dryRun) {
    if (verdict) return { lockPath, verdict, status: 'skipped', msg: '[dry-run] would reclaim ' + lockPath + ' (' + verdict + ')' };
    return { lockPath, verdict: null, status: 'skipped', msg: '[dry-run] would probe ' + lockPath + " via the daemon's own dead/reused/zombie/wedged-heartbeat liveness test (refuses a live, healthy holder)" };
  }

  if (typeof daemon.acquireIngestLock !== 'function') {
    return { lockPath, verdict: null, status: 'failed', msg: 'devswarm-ingest.js does not export acquireIngestLock in this build — cannot safely reclaim' };
  }

  // SLEEP/WAKE GRACE WINDOW (P0 fix). `verdict` is null here means the preview
  // classification found no confirmed dead/reused/zombie reason — the pid
  // reads alive, so acquireIngestLock's own wedged-heartbeat check is what
  // decides next, and THAT check is signal-capable (SIGKILL). It currently
  // decides "wedged" from a single already-on-disk timestamp snapshot: a
  // machine sleep/suspend longer than INGEST_LOCK_STALE_MS makes a genuinely
  // healthy holder's lock AND heartbeat both look stale the INSTANT the
  // machine wakes — before its loop gets a chance to run release.heartbeat()
  // again (which happens at the top of every iteration, but a daemon that was
  // blocked inside its one long-running child call when the machine slept
  // stays blocked, post-wake, for up to that call's own hardTimeoutMs before
  // it can reach the top of the loop again — see devswarm-ingest.js's
  // runIngestLoop/acquireIngestLock comments).
  //
  // Re-observe the SAME lock file's own record after a real-time grace window
  // sized to that same hardTimeoutMs bound, and require it to be UNCHANGED
  // (identical pid + ts) before ever calling the signal-capable path. A
  // holder that resumed and made progress will have refreshed its lock ts by
  // then — this is NOT wedged, so refuse without ever risking a kill. Only a
  // holder whose lock is STILL frozen after waiting out that same window is
  // allowed through to acquireIngestLock's own (already stricter) heartbeat
  // check. `io.sleep` / `io.reclaimGraceMs` are test-injection seams (fail
  // toward the grace check firing on any read error, i.e. we do NOT skip the
  // wait — an ambiguous re-read must never be treated as "unchanged, still
  // wedged" any more readily than before this fix).
  if (!verdict) {
    const timeoutSec = Number.isFinite(daemon.DEFAULT_MONITOR_TIMEOUT_SEC) ? daemon.DEFAULT_MONITOR_TIMEOUT_SEC : null;
    const defaultGraceMs = timeoutSec !== null ? (timeoutSec * 1000) + 10000 : RECLAIM_WEDGE_GRACE_FALLBACK_MS;
    const graceMs = Number.isFinite(io && io.reclaimGraceMs) ? io.reclaimGraceMs : defaultGraceMs;
    const sleepFn = (io && typeof io.sleep === 'function') ? io.sleep : defaultReclaimSleep;
    try { sleepFn(graceMs); } catch (_) {}
    let holderAfter = null;
    try { holderAfter = daemon.readLockHolder(lockPath, F); } catch (_) { holderAfter = null; }
    const unchanged = !!(holderAfter && holderAfter.pid === holder.pid && holderAfter.ts === holder.ts);
    if (!unchanged) {
      return { lockPath, verdict: null, status: 'skipped', msg: lockPath + ' holder refreshed its lock during the reclaim grace window — not wedged (was likely just resuming from a sleep/suspend), left untouched' };
    }
  }

  let release = null;
  try { release = daemon.acquireIngestLock(home, io, currentWorktree); } catch (e) {
    return { lockPath, verdict: null, status: 'failed', msg: 'acquireIngestLock raised while probing ' + lockPath + ': ' + errMsg(e) };
  }
  if (release) {
    try { release(); } catch (_) {}
    return { lockPath, verdict: verdict || 'wedged', status: 'fixed', msg: 'reclaimed ' + lockPath + " via the daemon's own dead/reused/zombie/wedged-heartbeat liveness test (" + (verdict || 'wedged') + ')' };
  }
  return { lockPath, verdict: null, status: 'skipped', msg: lockPath + ' is held by a live, healthy holder — left untouched (never reclaim a live daemon)' };
}

// reclaimIngestLocks({cwd, env, home, dryRun, platform, io}) ->
//   [{id, action, status, msg}]   status ∈ 'fixed' | 'skipped' | 'failed'
// The full `doctor --reclaim-ingest-lock` pass: (a) sweep every installed
// ingest lock machine-wide for a confirmed dead/zombie/reused holder, (b)
// additionally reclaim THIS worktree's own project lock via the
// wedged-heartbeat+SIGKILL path when neither of those apply, (c) trigger the
// existing reinstall (install-devswarm-ingest.js) ONLY when something was
// actually reclaimed for THIS worktree — never thrash an already-clean or
// already-healthy daemon. EXPLICIT, OPT-IN ONLY: this function is never called
// from runRepairs()'s default/--fix/--dry-run pass — only doctor.js's
// --reclaim-ingest-lock flag calls it, exactly like devswarm-recover is
// on-demand only.
function reclaimIngestLocks(opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const env = o.env || process.env;
  const home = o.home || os.homedir();
  const dryRun = !!o.dryRun;
  const platform = o.platform || process.platform;
  const io = o.io;
  const results = [];
  const push = (id, action, status, msg) => results.push({ id, action, status, msg });

  if (platform === 'win32') {
    push('reclaim-ingest-lock', 'reclaim-ingest-lock', 'skipped', 'Windows: ingest daemon is a documented no-op — nothing to reclaim, never flapped');
    return results;
  }

  // (a) machine-wide sweep — never signals, only removes a confirmed-abandoned lock.
  const sweep = sweepOrphanedIngestLockFiles({ home, dryRun, io });
  for (const s of sweep) push(s.id, 'reclaim-ingest-lock-sweep', s.status, s.msg);

  // (b) this worktree's own project lock.
  let currentWorktree = null;
  try { const { resolveWorktree } = ingestConst(); if (typeof resolveWorktree === 'function') currentWorktree = resolveWorktree(cwd); } catch (_) {}
  let currentLockPath = null;
  let currentFixed = false;
  let currentVerdict = null;
  if (!currentWorktree) {
    push('reclaim-current-lock', 'reclaim-ingest-lock', 'skipped', 'cwd is not inside a resolvable git worktree — no per-project lock to reclaim from here');
  } else {
    const r = reclaimCurrentProjectLock({ home, currentWorktree, dryRun, io });
    currentLockPath = r.lockPath;
    currentFixed = r.status === 'fixed';
    currentVerdict = r.verdict || null;
    push('reclaim-current-lock', 'reclaim-ingest-lock', r.status, r.msg);
  }

  // (c) reinstall — ONLY when the sweep or (b) actually reclaimed (or, in
  // dry-run, PROVABLY would have reclaimed — see the `verdict` field's own
  // doc comment above for why the wedged-heartbeat case is excluded from that
  // dry-run claim) THIS worktree's own lock. A sweep hit on some OTHER
  // project's lock never triggers a reinstall here — each repo heals its own
  // daemon, same discipline as runRepairs' own ingest section.
  const sweptCurrentEntry = currentLockPath != null ? sweep.find((s) => s.lockPath === currentLockPath) : null;
  const sweptCurrent = !!(sweptCurrentEntry && sweptCurrentEntry.status === 'fixed');
  const wouldReclaimCurrent = !!(sweptCurrentEntry && sweptCurrentEntry.verdict) || !!currentVerdict;
  if (!currentFixed && !sweptCurrent && !wouldReclaimCurrent) {
    push('reclaim-reinstall', 'install-ingest', 'skipped', 'nothing was reclaimed for this worktree — reinstall not triggered (never thrash an already-clean/healthy daemon)');
  } else if (!currentWorktree) {
    push('reclaim-reinstall', 'install-ingest', 'skipped', 'cwd is not inside a resolvable git worktree — cannot reinstall from here');
  } else if (dryRun) {
    push('reclaim-reinstall', 'install-ingest', 'skipped', '[dry-run] would (re)install the ingest daemon after reclaiming its lock');
  } else {
    // `io.install` (tests only) intercepts the real spawnInstaller call — this
    // is the ONE step in this whole file that genuinely registers a real
    // launchd/systemd job against the REAL user session regardless of any HOME
    // env override (same caveat doctor-repair.test.js's own reconcile suite
    // documents for the exact same reason), so a hermetic test must NEVER let
    // this branch reach the real spawnInstaller — it injects io.install
    // instead. Production never sets io.install, so this is unchanged there.
    const install = (io && typeof io.install === 'function') ? io.install : () => spawnInstaller(INGEST_INSTALLER, [], cwd, env);
    let r = null;
    try { r = install(); } catch (e) { r = { error: e }; }
    const ok = !!(r && !r.error && r.status === 0);
    push('reclaim-reinstall', 'install-ingest', ok ? 'fixed' : 'failed',
      'reinstalled the ingest daemon after reclaiming its lock (exit ' + (r && r.status) + ')' + (r && r.error ? ' — ' + errMsg(r.error) : ''));
  }

  return results;
}

// Friendly (plugin-relative) command strings for the manual-command hints in
// GATED reports — humans copy these, so keep them repo-relative not absolute.
const CMD_INGEST     = 'node plugins/anti-hall/companion/install-devswarm-ingest.js';
const CMD_SUPERVISOR = 'node plugins/anti-hall/companion/install-devswarm-supervisor.js';
const CMD_REAPER     = 'node plugins/anti-hall/companion/install-reaper.js';
const CMD_RECONCILE  = 'node plugins/anti-hall/scripts/devswarm.js reconcile';

// LABEL/UNIT/marker come from the installers themselves — NEVER re-derived here, so
// this can't drift from what install actually writes (same discipline as doctor.js).
function ingestConst() {
  try { return require(INGEST_INSTALLER); } catch (_) { return {}; }
}

// resolveCurrentStableScript(env, home) -> absolute path | null. Thin, fail-open
// wrapper around install-devswarm-ingest.js's OWN resolveStableScript (never
// re-derived here — same discipline as LABEL/UNIT above) so classifyIngestUnit can
// tell a script that still EXISTS apart from one that is the CURRENT canonical
// git-marketplace-clone path a fresh install would bake. Returns null (never
// throws) when the installer can't be required or the marketplace clone isn't on
// this machine — the caller then skips the drift check entirely (dev-mode/no
// marketplace has no "stable path" concept to drift from).
function resolveCurrentStableScript(env, home) {
  try {
    const { resolveStableScript } = ingestConst();
    if (typeof resolveStableScript === 'function') return resolveStableScript(env, home);
  } catch (_) {}
  return null;
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}
function firstLine(s) { return String(s || '').split('\n').find(Boolean) || ''; }
function errMsg(e) { return (e && e.message) ? e.message : String(e); }

// ---------------------------------------------------------------------------
// readInstalledIngestWorkingDir({home, platform, worktree|repoKey}) -> {present,
// workingDir, scriptPath, source, hash, repoKey, others}. PER-WORKTREE aware
// (v0.55+): delegates to the installer's listInstalledIngestUnits (the canonical
// multi-unit readback) and picks the unit that belongs to the CURRENT worktree so
// a wrong-path / stale-script unit for THIS repo can be detected and healed
// WITHOUT touching another repo's unit.
//   - o.repoKey given -> match the unit whose repoKey === o.repoKey (v0.57 mesh
//     Phase 6, D9/D24: the per-project unit install now actually creates —
//     mutually exclusive with the `worktree` mode below, and used by
//     update.js's healIngestDaemon so it heals what the installer really
//     produces post-reap-before-drain, not a unit that was just reaped).
//   - o.worktree given -> match the unit whose hash === worktreeHash(worktree),
//     or a legacy (hash-null) unit whose baked WorkingDirectory IS this worktree.
//   - neither given    -> the legacy (hash-null) unit if any, else the only unit.
// `others` carries the remaining installed units (OTHER worktrees) for reporting.
// Fail-open: any error -> present:false with an empty `others`.
// ---------------------------------------------------------------------------
function readInstalledIngestWorkingDir(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const platform = o.platform || process.platform;
  const out = { present: false, workingDir: null, scriptPath: null, source: null, hash: null, repoKey: null, others: [] };

  let units = [];
  try {
    const { listInstalledIngestUnits } = ingestConst();
    if (typeof listInstalledIngestUnits === 'function') units = listInstalledIngestUnits({ home, platform }) || [];
  } catch (_) { units = []; }
  if (!units.length) return out;

  let wantHash = null;
  if (o.worktree) {
    try { const { worktreeHash } = ingestConst(); if (typeof worktreeHash === 'function') wantHash = worktreeHash(o.worktree); } catch (_) {}
  }

  let pick = null;
  if (o.repoKey) {
    pick = units.find((u) => u.repoKey === o.repoKey) || null;
  } else if (o.worktree) {
    // Only a unit that genuinely belongs to THIS worktree may be healed in place.
    pick = units.find((u) => wantHash && u.hash === wantHash)
      || units.find((u) => u.hash === null && u.workingDir && samePath(u.workingDir, o.worktree))
      || null;
  } else {
    pick = units.find((u) => u.hash === null) || units[0] || null;
  }

  if (pick) {
    out.present = true;
    out.workingDir = pick.workingDir;
    out.scriptPath = pick.scriptPath;
    out.source = pick.source;
    out.hash = pick.hash;
    out.repoKey = pick.repoKey != null ? pick.repoKey : null;
  }
  out.others = units.filter((u) => u !== pick);
  return out;
}

function samePath(a, b) {
  try { return path.resolve(String(a)) === path.resolve(String(b)); } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// classifyIngestUnit({workingDir, scriptPath, home, env}) ->
//   'absent' | 'wrong-path' | 'stale-script' | 'unstable-script' | 'ok'
// WRONG-PATH: workingDir absent, equals $HOME, a non-existent path, or NOT inside a
// git worktree. STALE-SCRIPT: the baked ExecStart script no longer exists on disk.
// UNSTABLE-SCRIPT (v0.56.0, config drift within the CURRENT scheme): the baked
// script EXISTS but is not install-devswarm-ingest.js's current
// resolveStableScript() result — e.g. a unit installed before that fix still
// points at a version-pinned plugin-cache path the manager can relocate/.bak out
// from under it on the next update, even though nothing is missing YET. Opt-in:
// only checked when the caller passes `env` (real callers — runRepairs below,
// mirrored by update.js's healIngestDaemon — always do); a bare classify call that
// omits `env` keeps the pre-v0.56.0 existence-only check, so a placeholder
// scriptPath in a low-level unit test never false-flags against whatever build
// happens to be marketplace-installed on the machine running the test.
// ---------------------------------------------------------------------------
function classifyIngestUnit(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const workingDir = o.workingDir;
  const scriptPath = o.scriptPath;

  // Nothing readable at all -> no unit installed.
  if (!workingDir && !scriptPath) return 'absent';

  // WrongPath checks first (a unit that can never resolve a workspace).
  if (!workingDir) return 'wrong-path';
  if (path.resolve(workingDir) === path.resolve(home)) return 'wrong-path';
  let isDir = false;
  try { isDir = fs.statSync(workingDir).isDirectory(); } catch (_) { isDir = false; }
  if (!isDir) return 'wrong-path';
  if (!insideWorktree(workingDir)) return 'wrong-path';

  // Then stale-script: the baked script path is gone.
  if (scriptPath) {
    let scriptExists = false;
    try { scriptExists = fs.statSync(scriptPath).isFile(); } catch (_) { scriptExists = false; }
    if (!scriptExists) return 'stale-script';

    if (o.env) {
      const stable = resolveCurrentStableScript(o.env, home);
      if (stable) {
        let drifted = false;
        try { drifted = path.resolve(scriptPath) !== path.resolve(stable); } catch (_) { drifted = false; }
        if (drifted) return 'unstable-script';
      }
    }
  }
  return 'ok';
}

// insideWorktree(dir) -> bool. Reuses install-devswarm-ingest.resolveWorktree
// (git -C dir rev-parse --show-toplevel) so the "is this a git worktree" test is
// byte-identical to the one the installer itself gates on.
function insideWorktree(dir) {
  try {
    const { resolveWorktree } = ingestConst();
    if (typeof resolveWorktree === 'function') return resolveWorktree(dir) !== null;
  } catch (_) {}
  // Fallback: a direct git probe (never throws to the caller).
  try {
    const r = cp.spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    return !r.error && r.status === 0 && String(r.stdout || '').trim() !== '';
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Shared detection helpers (mirror doctor.js's own read-only scans, so a repair
// decision uses the same evidence the diagnostic section prints).
// ---------------------------------------------------------------------------
function scanStatusLine(cwd, home) {
  const scopes = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.json'),
  ];
  for (const p of scopes) {
    const s = readJSON(p);
    const cmd = s && s.statusLine && s.statusLine.command;
    if (cmd) return { present: true, path: p, command: cmd };
  }
  return { present: false };
}

// codexInstallerMod() — lazy require of codex/install-codex.js, the single
// source of truth for both the canonical hook set (ANTI_HALL_HOOKS) and the
// anti-hall-owned-group matcher (isAntiHallGroup). require()-ing it is safe:
// install-codex.js guards its own main()/file-writing behind
// `require.main === module`, so pulling in these exports never mutates disk.
function codexInstallerMod() {
  try { return require(CODEX_INSTALLER); } catch (_) { return {}; }
}

// scanCodex — PRECISE per-event wiring check. A prior version of this function
// (and doctor.js's read-only mirror of it) treated Codex as "wired" the moment
// ANY anti-hall hook fragment ('/plugins/anti-hall/hooks/') appeared anywhere
// in hooks.json. That made an upgrade silently invisible: an existing install
// with only the OLDER event set (e.g. missing a newly-added PostToolUse entry)
// still matched the coarse substring test on its older events and was reported
// "already wired", so `doctor --fix` never re-ran the installer to add the new
// event. Now every event key present in ANTI_HALL_HOOKS must have a matching
// anti-hall-owned group actually registered under that SAME event in the
// user's hooks.json — if even one expected event is missing/unwired, the whole
// scope is reported unwired so the AUTO-SAFE repair below re-runs the
// installer (mergeHooks() is additive per-event and safe to re-run — see its
// own doc comment in install-codex.js).
function scanCodex(cwd, home) {
  const { ANTI_HALL_HOOKS, isAntiHallGroup } = codexInstallerMod();
  const expectedEvents = ANTI_HALL_HOOKS && typeof ANTI_HALL_HOOKS === 'object' ? Object.keys(ANTI_HALL_HOOKS) : [];
  const scopesX = [
    ['project', path.join(cwd, '.codex'), []],
    ['global',  path.join(home, '.codex'), ['--global']],
  ];
  const out = [];
  for (const [label, dir, flags] of scopesX) {
    let hasConfig = false;
    try { hasConfig = fs.statSync(path.join(dir, 'config.toml')).isFile(); } catch (_) {}
    if (!hasConfig) continue;
    let wired = null; // null = hooks.json absent/unreadable
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
      const hooksByEvent = cfg && typeof cfg === 'object' && cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};
      if (typeof isAntiHallGroup === 'function' && expectedEvents.length) {
        wired = expectedEvents.every((event) => {
          const groups = Array.isArray(hooksByEvent[event]) ? hooksByEvent[event] : [];
          return groups.some((g) => isAntiHallGroup(g));
        });
      } else {
        // Defensive fallback only (install-codex.js failed to require, or
        // exports missing) — never crash the scan; falls back to the old
        // coarse substring test rather than reporting a hard failure.
        wired = JSON.stringify(cfg).replace(/\\\\/g, '/').includes('/plugins/anti-hall/hooks/');
      }
    } catch (_) { wired = null; }
    out.push({ label, dir, flags, wired });
  }
  return out;
}

// unitInstalled(installerPath, home, platform) -> bool. Read-only existence check
// of a companion's scheduler artifact, keyed to LABEL/UNIT from the installer.
function unitInstalled(installerPath, home, platform) {
  try {
    const inst = require(installerPath);
    if (platform === 'darwin') return fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `${inst.LABEL}.plist`));
    if (platform === 'linux') return fs.existsSync(path.join(home, '.config', 'systemd', 'user', `${inst.UNIT}.timer`));
  } catch (_) {}
  return false; // win32 / unknown / require-fail = not installed
}

// spawnInstaller — run one of the plugin's OWN idempotent installers as a
// subprocess (never a hand-written plist). cwd + env are threaded so os.homedir()
// and resolveWorktree() inside the child resolve to the same home/worktree doctor
// is operating on.
function spawnInstaller(script, argv, cwd, env) {
  return cp.spawnSync(process.execPath, [script].concat(argv || []), {
    cwd, env, encoding: 'utf8', timeout: 30000,
  });
}

// ---------------------------------------------------------------------------
// reapOrphanedLegacyUnits({home, platform, dryRun, now, io}) ->
//   [{id, hash, workingDir, status, msg}]  status ∈ 'reaped'|'would-reap'|'kept'|'failed'
//
// v0.57 mesh Phase 6 (D9/D25/D28) — BELT-AND-SUSPENDERS sweep for LEGACY
// per-worktree ingest units that are ALREADY orphaned or REDUNDANT. This is NOT
// the live reap-before-drain handoff (that already happens INSIDE
// install-devswarm-ingest.js's install path — see reapLegacyUnitsForRepo — every
// time the per-project daemon is (re)installed for a repo). This sweep exists for
// the units that handoff never touched: a worktree that was deleted WITHOUT ever
// re-running install (no reap trigger fired), or a machine where the install-time
// stop silently failed (launchctl/systemctl errors are ignored at install time,
// D9).
//
// A legacy unit is reaped when EITHER:
//   (a) its worktree no longer resolves at all (genuinely orphaned), OR
//   (b) its worktree still resolves AND the per-project daemon for that
//       worktree's repoKey is CONFIRMED running+healthy (D25 — freshness AND
//       lock/process evidence, never freshness alone) — i.e. this legacy unit is
//       provably redundant.
// Otherwise it is LEFT IN PLACE (status 'kept') — never reap a legacy unit that
// might still be the SOLE live drainer of its Primary queue; reaping it then
// would silently stop ingestion with no replacement.
//
// Only units bearing the anti-hall ingest LABEL/UNIT prefix with the LEGACY
// `-<hash>` shape are candidates (`u.hash != null` — the DISJOINT regex in
// listInstalledIngestUnits, D28) — a repoKey-shaped per-project unit, or any
// non-anti-hall scheduler entry, is never enumerated by listInstalledIngestUnits
// in the first place, so neither is ever a candidate here.
//
// Stop is ALWAYS scheduler-based (launchctl unload / systemctl disable / cron-
// marker removal via stopLegacyUnitEntry) — NEVER kill(2); a currently-live
// legacy daemon's own finally block releases its lock+store cleanly once its
// scheduler unit is torn down. `opts.io` (schedRun/schedFs/fs/isAlive) is fully
// injectable so tests NEVER touch a real launchctl/systemctl/crontab/process —
// mirrors reapLegacyUnitsForRepo's own opts.io.schedRun/schedFs discipline.
// Fail-open per unit: one unit that raises while being evaluated/stopped is
// reported 'failed' and never blocks sweeping the rest.
function reapOrphanedLegacyUnits(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const platform = o.platform || process.platform;
  const dryRun = !!o.dryRun;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const results = [];

  let units = [];
  try {
    const { listInstalledIngestUnits } = ingestConst();
    if (typeof listInstalledIngestUnits === 'function') units = listInstalledIngestUnits({ home, platform }) || [];
  } catch (_) { units = []; }

  // ONLY legacy per-worktree-suffixed units (hash set). Never the ambiguous
  // legacy BASE unit (hash===null, repoKey===null — owned by the existing GATED
  // ingest-install section above) and NEVER a repoKey-shaped per-project unit
  // (hash===null, repoKey set — D28 disjoint regex guarantees this).
  const candidates = units.filter((u) => u && u.hash != null);

  for (const u of candidates) {
    const rid = 'reap-legacy-' + u.hash;
    try {
      const worktreeGone = !u.workingDir || !insideWorktree(u.workingDir);
      let reason = null;
      if (worktreeGone) {
        reason = 'orphaned — worktree no longer resolves (' + (u.workingDir || 'unset') + ')';
      } else {
        let repoKey = null;
        try {
          const { repoKeyForWorktree } = repokeyMod();
          if (typeof repoKeyForWorktree === 'function') repoKey = repoKeyForWorktree(u.workingDir);
        } catch (_) { repoKey = null; }
        if (repoKey && projectDaemonHealthy(home, repoKey, now, o.io)) {
          reason = 'redundant — the per-project daemon for repoKey ' + repoKey + ' is confirmed running+healthy';
        }
      }
      if (!reason) {
        results.push({ id: rid, hash: u.hash, workingDir: u.workingDir, status: 'kept', msg: 'legacy ingest unit ' + u.hash + ' left in place (worktree resolves, no confirmed-healthy replacement — may still be the sole drainer)' });
        continue;
      }
      if (dryRun) {
        results.push({ id: rid, hash: u.hash, workingDir: u.workingDir, status: 'would-reap', msg: '[dry-run] would reap legacy ingest unit ' + u.hash + ': ' + reason });
        continue;
      }
      const { stopLegacyUnitEntry } = ingestConst();
      if (typeof stopLegacyUnitEntry === 'function') {
        stopLegacyUnitEntry({ label: u.label, unit: u.unit, hash: u.hash }, { platform, home, io: o.io });
      }
      results.push({ id: rid, hash: u.hash, workingDir: u.workingDir, status: 'reaped', msg: 'reaped legacy ingest unit ' + u.hash + ' (' + reason + ') via the scheduler (never kill)' });
    } catch (e) {
      results.push({ id: rid, hash: u.hash, workingDir: u.workingDir, status: 'failed', msg: 'reap of legacy ingest unit ' + u.hash + ' raised: ' + errMsg(e) });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// runRepairs({cwd, env, home, dryRun, platform, io}) -> [{id, action, status, msg}]
//   status ∈ 'fixed' | 'gated' | 'skipped' | 'failed'
//   `io` ({fs, isAlive}) is threaded to the ingest daemon-liveness check
//   (projectDaemonHealthy) and the legacy-unit orphan sweep — optional, tests
//   only; omitted in production so both use real fs/process.kill.
// ---------------------------------------------------------------------------
function runRepairs(opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const env = o.env || process.env;
  const home = o.home || os.homedir();
  const dryRun = !!o.dryRun;
  const platform = o.platform || process.platform;
  const results = [];
  const push = (id, action, status, msg) => results.push({ id, action, status, msg });

  // GATE — GATED fixes need BOTH a DevSwarm-active env AND a real git worktree cwd.
  let gateOpen = false;
  try {
    const { isDevswarmActive } = require('./devswarm-detect.js');
    const { resolveWorktree } = ingestConst();
    gateOpen = !!(isDevswarmActive(env) && typeof resolveWorktree === 'function' && resolveWorktree(cwd) !== null);
  } catch (_) { gateOpen = false; }
  const gatedHint = (cmd) =>
    'DevSwarm gate closed (needs an active DevSwarm session + a git-worktree cwd). Run manually from the worktree: ' + cmd;

  // The worktree doctor is operating on — used to pick THIS repo's ingest unit out of
  // the (possibly multi-repo) set of installed units, so a wrong-path/stale unit for
  // this repo is healed while OTHER repos' units are only reported, never touched.
  let currentWorktree = null;
  try { const { resolveWorktree } = ingestConst(); if (typeof resolveWorktree === 'function') currentWorktree = resolveWorktree(cwd); } catch (_) {}

  // --- AUTO-SAFE: state migrations -----------------------------------------
  migrationFix('migrate-legacy', 'migrate-legacy-state', () => {
    const r = require(MIGRATE_STATE).migrateLegacyState({ dir: cwd, dryRun: true });
    const pending = r.filter((x) => x.action === 'pending').map((x) => x.file);
    return { pending: pending.length > 0, detail: pending.join(', ') };
  }, () => require(MIGRATE_STATE).migrateLegacyState({ dir: cwd }));

  migrationFix('migrate-gsd', 'migrate-gsd-planning', () => {
    const r = require(MIGRATE_STATE).migrateGsdPlanning({ dir: cwd, dryRun: true });
    const pending = r.filter((x) => x.action === 'pending').map((x) => x.file);
    return { pending: pending.length > 0, detail: pending.length + ' file(s)' };
  }, () => require(MIGRATE_STATE).migrateGsdPlanning({ dir: cwd }));

  migrationFix('migrate-devswarm-store', 'migrate-devswarm-store', () => {
    const r = require(MIGRATE_STATE).migrateDevswarmStore({ dryRun: true });
    return { pending: !!(r && r.pending), detail: (r && r.workspaces || 0) + ' workspace(s)' };
  }, () => require(MIGRATE_STATE).migrateDevswarmStore({}));

  // Task #4: normalize parent-gate reply-state files from the legacy single-
  // merged-object shape to the new append-only JSONL shape. A PURE per-user-file
  // fold+rewrite under ~/.anti-hall/devswarm/parent-gate/ (no daemon/scheduler
  // side effect, no store open) -> AUTO-SAFE, same posture as
  // migrate-devswarm-store above. Reuses migrate-state.js's migrateReplyState
  // (itself delegating to devswarm-reply-state.js) for BOTH the dry-run detect
  // and the apply — one code path, idempotent (an already-append-only file is
  // never rewritten), fail-open, NO-DELETE (the fold keeps every sender's max).
  migrationFix('migrate-reply-state', 'migrate-reply-state', () => {
    const r = require(MIGRATE_STATE).migrateReplyState({ dryRun: true, home });
    return { pending: !!(r && r.pending > 0), detail: (r && r.pending || 0) + ' reply-state file(s)' };
  }, () => require(MIGRATE_STATE).migrateReplyState({ home }));

  // #70: fold ALL prior mesh forms (phantom rows, dual/legacy pairs, subdir-splits)
  // into one canonical survivor per worktree. A PURE store read+write (forward-then-
  // tombstone, message rows NEVER deleted) — so AUTO-SAFE, not GATED (no daemon /
  // scheduler side effect; same posture as migrate-devswarm-store above). Reuses
  // devswarm.js's foldMeshDuplicates for BOTH the dry-run detect and the apply — one
  // code path, idempotent (a re-run tombstones nothing left), fail-open.
  migrationFix('fold-mesh-duplicates', 'fold-mesh-duplicates', () => {
    const r = require(DEVSWARM_SCRIPT).foldMeshDuplicates(home, { cwd, env, dryRun: true });
    const n = (r && Array.isArray(r.retired)) ? r.retired.length : 0;
    const leftN = (r && Array.isArray(r.left)) ? r.left.length : 0;
    const rekeyN = (r && Number.isFinite(r.rekeyed)) ? r.rekeyed : 0; // P1b: subdir rows to re-key to their toplevel
    return {
      pending: n > 0 || rekeyN > 0,
      detail: (n > 0 ? (n + ' duplicate mesh row(s) to fold') : (rekeyN + ' subdir mesh row(s) to re-key'))
        + (n > 0 && rekeyN ? ' + ' + rekeyN + ' subdir re-key' : '')
        + (leftN ? ' (' + leftN + ' descriptor-backed left in place)' : ''),
    };
  }, () => require(DEVSWARM_SCRIPT).foldMeshDuplicates(home, { cwd, env }));

  // Archived-still-active forward-migration: cmdArchive used to tombstone exactly
  // ONE registry row per archive, while up to four rows (hivecontrol builder UUID,
  // `primary-<8hex>` spawn phantom, legacy ingested `<label>-<repoId8>`, subdir-
  // derived) can exist for ONE worktree — and computeSummary projects any live row
  // as an ACTIVE workspace, so an archived workspace kept reading active under a
  // surviving duplicate. This retires the whole same-worktree group for every
  // genuinely archived workspace, forwarding unread directs into the archived id's
  // partition FIRST (message rows are NEVER deleted) and leaving any row backed by
  // a DIFFERENT live descriptor untouched. Pure store read+write (no daemon or
  // scheduler side effect) -> AUTO-SAFE, same posture as fold-mesh-duplicates
  // above. Reuses devswarm.js's foldArchivedRegistryRows for BOTH the dry-run
  // detect and the apply — one code path, idempotent, fail-open.
  migrationFix('fold-archived-rows', 'fold-archived-rows', () => {
    const dw = require(DEVSWARM_SCRIPT);
    if (typeof dw.foldArchivedRegistryRows !== 'function') return { pending: false, detail: 'build has no foldArchivedRegistryRows' };
    const r = dw.foldArchivedRegistryRows(home, { cwd, env, dryRun: true }) || {};
    const n = r.pending || 0;
    const leftN = Array.isArray(r.left) ? r.left.length : 0;
    return {
      pending: n > 0,
      detail: n + ' registry row(s) of archived workspace(s) to retire'
        + (leftN ? ' (' + leftN + ' safety-gated row(s) left in place)' : ''),
    };
  }, () => require(DEVSWARM_SCRIPT).foldArchivedRegistryRows(home, { cwd, env }));

  // P1-8: backfill the new `ownerKey` descriptor field on every descriptor
  // (active AND archived) + heal prior hash-bucket split-brain via re-home. A
  // pure descriptor/store forward-migration (idempotent, fail-open, NO-DELETE) —
  // AUTO-SAFE, same posture as fold-mesh-duplicates. Reuses devswarm.js's
  // migrateOwnerKeys for BOTH the dry-run detect and the apply (one code path).
  migrationFix('owner-key-migrate', 'owner-key-migrate', () => {
    const dw = require(DEVSWARM_SCRIPT);
    if (typeof dw.migrateOwnerKeys !== 'function') return { pending: false, detail: 'build has no migrateOwnerKeys' };
    const r = dw.migrateOwnerKeys(home, { cwd, env, dryRun: true }) || {};
    const n = (r.backfilled || 0) + (r.rehomed || 0);
    return { pending: n > 0, detail: (r.backfilled || 0) + ' ownerKey backfill + ' + (r.rehomed || 0) + ' re-home' };
  }, () => require(DEVSWARM_SCRIPT).migrateOwnerKeys(home, { cwd, env }));

  // G2: discharge any lingering cmdArchive recovery-intent marker (a prior archive
  // whose registry tombstone landed but whose in-process rollback/clear did not —
  // ENOSPC or a process kill). A pure store re-upsert (revive) or a stale-marker
  // clear, idempotent + fail-open + NO-DELETE — AUTO-SAFE, same posture as the
  // owner-key migration. Reuses devswarm.js's applyRecoveryIntents for BOTH the
  // dry-run detect and the apply (one code path).
  migrationFix('recover-archive-intent', 'recover-archive-intent', () => {
    const dw = require(DEVSWARM_SCRIPT);
    if (typeof dw.applyRecoveryIntents !== 'function') return { pending: false, detail: 'build has no applyRecoveryIntents' };
    const r = dw.applyRecoveryIntents(home, { cwd, env, dryRun: true }) || {};
    return { pending: (r.pending || 0) > 0, detail: (r.pending || 0) + ' archive recovery-intent(s)' };
  }, () => require(DEVSWARM_SCRIPT).applyRecoveryIntents(home, { cwd, env }));

  // Claim 3 self-heal MIGRATION: sweep EVERY per-project store's registry for a
  // row whose descriptor's own real worktreePath disagrees with the store it
  // is physically sitting in (mis-keyed — rehomed out, zero message loss) or
  // carries a stale persisted ownerKey/repoKey/registry worktree_path (healed
  // in place). Heals the real breakage class this migration targets: a row
  // living under store/<staleRepoKey>/ whose descriptor's worktreePath
  // structurally belongs to a DIFFERENT, current repoKey (e.g. a submodule
  // split, or a stray row left by an earlier bug/race). Reuses devswarm.js's
  // own exported healRegistry(home, repoKey, ctx) — the ONE heal primitive the
  // core Claim 3 fix built (see rehomeMiskeyedRow's doc comment for the full
  // decision tree: correctly-homed-but-stale vs genuinely-mis-keyed vs
  // unresolvable/left-untouched) — this integration layer does not reimplement
  // any of that decision logic, it only ENUMERATES every store to sweep.
  //
  // Pure store read+write (descriptor field heal + registry upsert, or a
  // message-preserving rehome) — no daemon/scheduler side effect, so this is
  // AUTO-SAFE, same posture as fold-mesh-duplicates/owner-key-migrate above
  // (NOT gated on isDevswarmActive/resolveWorktree). NO-DELETE: healRegistry's
  // own contract never deletes a message, only tombstones a registry row AFTER
  // its content has been verified-copied into the correct store (the same
  // precedent rehomeCore/foldMeshDuplicates already use).
  //
  // healRegistry has no separate dry-run mode of its own (each row's fix IS
  // the detection — there is no side-effect-free way to preview it without
  // literally computing what the real pass would do), so — same precedent as
  // the reconcile GATED repair below, which also cannot preview a per-worktree
  // drain without running it — --dry-run reports the action without scanning,
  // rather than using the generic migrationFix() dual-detect helper.
  // listStoreHashes/healRegistry both fail-open ([] / a zero-count result) on
  // an unparseable store, so a store this sweep cannot read is SKIPPED, never
  // wiped. Idempotent: a second sweep over an already-healed store finds
  // nothing left to heal (verified by devswarm-lifecycle.test.js's own
  // healRegistry idempotency test; this integration only adds enumeration).
  if (dryRun) {
    push('heal-registry-rows', 'heal-registry-rows', 'skipped', '[dry-run] would sweep every per-project store registry for mis-keyed/stale rows (devswarm.js healRegistry)');
  } else {
    try {
      const dw = require(DEVSWARM_SCRIPT);
      if (typeof dw.healRegistry !== 'function') {
        push('heal-registry-rows', 'heal-registry-rows', 'skipped', 'build has no healRegistry — nothing to sweep');
      } else {
        let hashes = [];
        try { hashes = require(DEVSWARM_STORE).listStoreHashes(home) || []; } catch (_) { hashes = []; }
        let checked = 0, healed = 0, rehomed = 0;
        const healedRows = [];
        for (const repoKey of hashes) {
          let r = null;
          try { r = dw.healRegistry(home, repoKey, { cwd, env }); } catch (_) { r = null; }
          if (!r) continue;
          checked += r.checked || 0;
          healed += r.healed || 0;
          rehomed += r.rehomed || 0;
          for (const row of (r.rows || [])) {
            if (row && (row.healedDescriptor || row.healedRegistryPath || row.rehomed)) {
              healedRows.push((row.id == null ? '?' : row.id) + '@' + repoKey);
            }
          }
        }
        if (healed === 0 && rehomed === 0) {
          push('heal-registry-rows', 'heal-registry-rows', 'skipped', 'checked ' + checked + ' registry row(s) across ' + hashes.length + ' store(s) — nothing mis-keyed/stale');
        } else {
          push('heal-registry-rows', 'heal-registry-rows', 'fixed', 'healed ' + healed + ' + rehomed ' + rehomed + ' of ' + checked + ' registry row(s) across ' + hashes.length + ' store(s): ' + healedRows.join(', '));
        }
      }
    } catch (e) {
      push('heal-registry-rows', 'heal-registry-rows', 'failed', 'heal-registry-rows raised: ' + errMsg(e));
    }
  }

  // --- AUTO-SAFE: statusline-if-missing ------------------------------------
  try {
    const sl = scanStatusLine(cwd, home);
    if (sl.present) {
      push('statusline', 'install-statusline', 'skipped', 'statusLine already configured — not touching a custom line (' + firstLine(sl.command).slice(0, 48) + ')');
    } else if (dryRun) {
      push('statusline', 'install-statusline', 'skipped', '[dry-run] would install the anti-hall statusline (--user)');
    } else {
      spawnInstaller(STATUSLINE_INSTALLER, ['--user'], cwd, env);
      const after = scanStatusLine(cwd, home);
      if (after.present) push('statusline', 'install-statusline', 'fixed', 'installed the anti-hall statusline (--user)');
      else push('statusline', 'install-statusline', 'failed', 'statusline still absent after install (does ~/.claude/settings.json exist?)');
    }
  } catch (e) {
    push('statusline', 'install-statusline', 'failed', 'statusline repair raised: ' + errMsg(e));
  }

  // --- AUTO-SAFE: codex hook refresh (only when config.toml exists) ---------
  try {
    const codex = scanCodex(cwd, home);
    for (const c of codex) {
      if (c.wired === true) {
        push('codex-' + c.label, 'install-codex', 'skipped', 'anti-hall codex hooks already wired (' + c.label + ')');
      } else if (dryRun) {
        push('codex-' + c.label, 'install-codex', 'skipped', '[dry-run] would refresh anti-hall codex hooks (' + c.label + ')');
      } else {
        spawnInstaller(CODEX_INSTALLER, c.flags, cwd, env);
        const after = scanCodex(cwd, home).find((x) => x.label === c.label);
        if (after && after.wired === true) push('codex-' + c.label, 'install-codex', 'fixed', 'wired anti-hall codex hooks (' + c.label + ')');
        else push('codex-' + c.label, 'install-codex', 'failed', 'codex hooks still unwired after refresh (' + c.label + ')');
      }
    }
  } catch (e) {
    push('codex', 'install-codex', 'failed', 'codex repair raised: ' + errMsg(e));
  }

  // --- Supervisor: AUTO-SAFE relaunch if installed, else GATED first-install -
  if (platform === 'win32') {
    push('supervisor', 'install-supervisor', 'skipped', 'Windows: DevSwarm recovery is a documented no-op (no safe cwd confirm-gate)');
  } else {
    try {
      const installed = unitInstalled(SUPERVISOR_INSTALLER, home, platform);
      if (installed) {
        if (dryRun) push('supervisor', 'refresh-supervisor', 'skipped', '[dry-run] would relaunch the installed supervisor (idempotent refresh)');
        else { spawnInstaller(SUPERVISOR_INSTALLER, [], cwd, env); push('supervisor', 'refresh-supervisor', 'fixed', 'relaunched the installed supervisor (idempotent refresh to this build)'); }
      } else if (!gateOpen) {
        push('supervisor', 'install-supervisor', 'gated', 'supervisor not installed. ' + gatedHint(CMD_SUPERVISOR));
      } else if (dryRun) {
        push('supervisor', 'install-supervisor', 'skipped', '[dry-run] would install the supervisor (gate open)');
      } else {
        spawnInstaller(SUPERVISOR_INSTALLER, [], cwd, env);
        const now = unitInstalled(SUPERVISOR_INSTALLER, home, platform);
        push('supervisor', 'install-supervisor', now ? 'fixed' : 'failed', now ? 'installed the supervisor companion' : 'supervisor still not installed after run');
      }
    } catch (e) {
      push('supervisor', 'install-supervisor', 'failed', 'supervisor repair raised: ' + errMsg(e));
    }
  }

  // --- Ingest daemon: GATED (install / wrong-path rebind / stale-script) ----
  if (platform === 'win32') {
    push('ingest', 'install-ingest', 'skipped', 'Windows: ingest daemon has no built-in scheduler (documented no-op)');
  } else {
    try {
      const read = readInstalledIngestWorkingDir({ home, platform, worktree: currentWorktree });
      // Report OTHER repos' installed ingest units (never healed here — each repo
      // heals its own from its own worktree). Informational only.
      if (read.others && read.others.length) {
        const list = read.others.map((u) => (u.workingDir || '(unknown worktree)')).join(', ');
        push('ingest-others', 'none', 'skipped', read.others.length + ' other ingest unit(s) installed for other worktree(s): ' + list);
      }
      const cls = classifyIngestUnit({ workingDir: read.workingDir, scriptPath: read.scriptPath, home, env });

      // Claim 5 H1 — daemon-LIVENESS gate. classifyIngestUnit is install-SHAPE
      // only (WorkingDirectory/ExecStart on disk) — it has no opinion on whether
      // the process behind that shape is actually alive. A launchd/systemd unit
      // can be perfectly well-formed while its daemon is crashed, OOM-killed, or
      // wedged (backoff-looping without ever re-acquiring its lock), and
      // classifyIngestUnit alone would still report 'ok', so doctor would print
      // "healthy" over a dead daemon. Gate 'ok' behind the SAME shared
      // daemonHealth() the legacy-unit orphan sweep's projectDaemonHealthy (and
      // ingest-health.js's own hot-path banner) all trust — never freshness
      // alone (a dead process can leave a fresh-looking heartbeat file within
      // the staleness window). repoKey comes off the installed unit when it's a
      // per-project unit (the common case); a legacy (hash-only) unit carries
      // no repoKey of its own, so it is derived from the worktree the same way
      // reapOrphanedLegacyUnits does. `alive` is only meaningful when
      // cls==='ok' — a unit with a shape problem is reported with ITS OWN
      // reason below, never masked by a liveness message.
      //
      // B2: this used to chain projectDaemonHealthy() (liveness only) +
      // monitorFaultFor() (a SECOND, separate call) — two calls into what is
      // now ONE shared daemonHealth() check, so this report and
      // projectDaemonHealthy can never drift on what "alive" means again.
      // status:'healthy' or 'failed' both mean the base liveness signals
      // (fresh heartbeat + live-pid lock + same incarnation) are POSITIVELY
      // confirmed — 'failed' additionally means the daemon is alive but
      // draining nothing (v0.66 monitor-outcome fault), reported as its own
      // distinct FAILURE reason below rather than a generic "not alive", and
      // healed by the same (re)install, which is genuinely the remedy: the
      // installer bakes the resolved binary + PATH into the regenerated unit.
      let alive = true;
      let monitorFault = null;
      if (cls === 'ok') {
        let repoKeyForHealth = read.repoKey;
        if (!repoKeyForHealth && currentWorktree) {
          try {
            const { repoKeyForWorktree } = repokeyMod();
            if (typeof repoKeyForWorktree === 'function') repoKeyForHealth = repoKeyForWorktree(currentWorktree);
          } catch (_) {}
        }
        if (repoKeyForHealth) {
          try {
            const healthMod = ingestHealthMod();
            const result = typeof healthMod.daemonHealth === 'function'
              ? healthMod.daemonHealth(home, repoKeyForHealth, { now: Date.now(), io: o.io })
              : null;
            alive = !!(result && (result.status === 'healthy' || result.status === 'failed'));
            monitorFault = (result && result.status === 'failed') ? result.monitorFault : null;
          } catch (_) { alive = false; monitorFault = null; }
        } else {
          alive = false;
        }
      }

      if (cls === 'ok' && alive && !monitorFault) {
        push('ingest', 'install-ingest', 'skipped', 'ingest daemon installed and healthy (WorkingDirectory ' + read.workingDir + ')');
      } else {
        const deadDaemon = cls === 'ok' && !alive; // install-shape fine, liveness check failed
        const reason = monitorFault ? monitorFaultReason(monitorFault, read.workingDir)
          : cls === 'absent' ? 'ingest daemon not installed'
          : cls === 'wrong-path' ? 'ingest daemon WorkingDirectory is wrong (' + (read.workingDir || 'unset') + ')'
          : cls === 'unstable-script' ? 'ingest daemon ExecStart script is not the current stable build (' + (read.scriptPath || 'unset') + ' — pinned to an old/relocatable path)'
          : cls === 'stale-script' ? 'ingest daemon ExecStart script is missing (' + (read.scriptPath || 'unset') + ')'
          : 'ingest daemon is installed but NOT ALIVE (stale heartbeat / lock not held by a live process — WorkingDirectory ' + read.workingDir + ')';
        if (!gateOpen) {
          push('ingest', 'install-ingest', 'gated', reason + '. ' + gatedHint(CMD_INGEST));
        } else if (dryRun) {
          let wt = cwd;
          try { const { resolveWorktree } = ingestConst(); wt = resolveWorktree(cwd) || cwd; } catch (_) {}
          push('ingest', 'install-ingest', 'skipped', '[dry-run] would (re)install the ingest daemon from ' + wt + ' (' + (monitorFault ? 'monitor-failing' : deadDaemon ? 'dead-daemon' : cls) + ')');
        } else {
          spawnInstaller(INGEST_INSTALLER, [], cwd, env);
          const read2 = readInstalledIngestWorkingDir({ home, platform, worktree: currentWorktree });
          const cls2 = classifyIngestUnit({ workingDir: read2.workingDir, scriptPath: read2.scriptPath, home, env });
          // A relaunch fixes the SHAPE immediately; it cannot prove the new
          // incarnation is alive within this same pass (the daemon has not had a
          // chance to write its first heartbeat yet) — so re-verification here,
          // like every other cls branch above, checks install-shape only.
          if (cls2 === 'ok') push('ingest', 'install-ingest', 'fixed', 'ingest daemon (re)installed — WorkingDirectory now ' + read2.workingDir + (deadDaemon ? ' (was installed but not alive; scheduler unit relaunched)' : ''));
          else push('ingest', 'install-ingest', 'failed', 'ingest daemon still ' + cls2 + ' after reinstall');
        }
      }
    } catch (e) {
      push('ingest', 'install-ingest', 'failed', 'ingest repair raised: ' + errMsg(e));
    }
  }

  // --- Legacy ingest unit orphan sweep: GATED (v0.57 mesh Phase 6, D9/D25/D28) -
  // Belt-and-suspenders reap of legacy per-worktree units already orphaned or
  // provably redundant. Distinct from the ingest section above (which heals THIS
  // worktree's own unit): this sweeps ALL installed legacy units on the machine,
  // so it stays behind the SAME DevSwarm-active + git-worktree gate as every
  // other daemon-touching repair (never mutates scheduler state for an idle/non-
  // DevSwarm session).
  if (platform === 'win32') {
    push('reap-legacy-ingest', 'reap-legacy-ingest', 'skipped', 'Windows: no scheduler to reap legacy ingest units from (documented no-op)');
  } else if (!gateOpen) {
    push('reap-legacy-ingest', 'reap-legacy-ingest', 'gated', 'legacy-ingest-unit orphan sweep skipped. ' + gatedHint(CMD_INGEST));
  } else {
    try {
      const reapResults = reapOrphanedLegacyUnits({ home, platform, dryRun, env });
      if (!reapResults.length) {
        push('reap-legacy-ingest', 'reap-legacy-ingest', 'skipped', 'no legacy per-worktree ingest units installed — nothing to sweep');
      } else {
        for (const r of reapResults) {
          const status = r.status === 'reaped' ? 'fixed'
            : r.status === 'failed' ? 'failed'
            : 'skipped'; // 'kept' | 'would-reap' — informational, not a failure
          push(r.id, 'reap-legacy-ingest', status, r.msg);
        }
      }
    } catch (e) {
      push('reap-legacy-ingest', 'reap-legacy-ingest', 'failed', 'legacy-ingest-unit orphan sweep raised: ' + errMsg(e));
    }
  }

  // --- Reconcile: GATED (drains stranded per-worktree native hivecontrol queues
  // into the shared store) ----------------------------------------------------
  // v0.58.0 shipped `node scripts/devswarm.js reconcile` as a MANUAL-only verb.
  // Wired here as an auto-heal under the SAME DevSwarm gate as every other
  // daemon-touching repair above — safe to auto-run because devswarm.js's own
  // cmdReconcile (and the devswarm-pull.js pullOnce it drives per worktree) is:
  //   - IDEMPOTENT: pullOnce's collectExistingHashes dedupes every recovered
  //     message by content hash (devswarm-pull.js) before appending, so a
  //     re-run imports 0 new messages (already-seen ones count as `duplicate`,
  //     never re-appended).
  //   - LOCK-RESPECTING: pullOnce takes the per-id O_EXCL pull lock
  //     (devswarm-pull.js's acquireExclLock) before touching a worktree's
  //     queue; a worktree a live child is ALREADY draining is SKIPPED (never
  //     raced) and surfaced back as `locked:true` on that descriptor's result,
  //     never silently dropped from the count.
  //   - LOSS-FREE: pullOnce's own RECONCILIATION check compares the native
  //     message-count against what actually landed in the durable inbox/store;
  //     a shortfall fails loud with a `lost` field (devswarm-pull.js) rather
  //     than silently discarding messages — drained messages land in the
  //     SHARED store (store.openStore + ingestPayload/deriveSummary), never a
  //     throwaway.
  // Gate-fail REPORTS the exact manual command and mutates nothing (never
  // spawns a single per-worktree drain). --dry-run never spawns either — a
  // genuine live preview would need a NEW non-destructive count-only mode
  // cmdReconcile does not have; reporting the action without a per-worktree
  // preview matches this file's existing ingest/supervisor dry-run precedent
  // above (which also reports the action, not a live diff).
  if (!gateOpen) {
    push('reconcile', 'reconcile', 'gated', 'stranded per-worktree DevSwarm queues not swept. ' + gatedHint(CMD_RECONCILE));
  } else if (dryRun) {
    push('reconcile', 'reconcile', 'skipped', '[dry-run] would run reconcile (drain stranded per-worktree native queues into the shared store) from ' + (currentWorktree || cwd));
  } else {
    try {
      const devswarm = require(DEVSWARM_SCRIPT);
      const { result } = devswarm.run(['reconcile'], { cwd, env, home });
      if (result && result.ok) {
        push('reconcile', 'reconcile', 'fixed', 'reconciled ' + result.count + ' worktree(s) — imported ' + result.imported + ' message(s) into the shared store');
      } else if (result && result.lost) {
        // P1 fix: a reconcile that LOST messages (real shortfall, distinct
        // from a benign `locked` contention skip) must never be reported as
        // fixed — that would tell the user everything is fine while
        // messages actually vanished. cmdReconcile now returns ok:false with
        // a `lost` total whenever ANY target reports a shortfall.
        push('reconcile', 'reconcile', 'failed', 'reconcile LOST ' + result.lost + ' message(s) across ' + (result.count || 0) + ' worktree(s) — see per-worktree detail: ' + CMD_RECONCILE);
      } else {
        push('reconcile', 'reconcile', 'failed', 'reconcile failed: ' + ((result && (result.reason || result.error)) || 'unknown error'));
      }
    } catch (e) {
      push('reconcile', 'reconcile', 'failed', 'reconcile raised: ' + errMsg(e));
    }
  }

  // --- Reaper: REPORT-ONLY (kills orphans on a timer — never auto-installed) -
  if (platform !== 'win32') {
    try {
      const installed = unitInstalled(REAPER_INSTALLER, home, platform);
      if (installed) push('reaper', 'none', 'skipped', 'MCP orphan reaper installed');
      else push('reaper', 'none', 'skipped', 'MCP orphan reaper not installed (report-only — it kills orphans on a timer, never auto). To enable: ' + CMD_REAPER);
    } catch (e) {
      push('reaper', 'none', 'skipped', 'reaper check raised: ' + errMsg(e));
    }
  }

  // --- Wake-monitor (Monitor-based idle-wake): REPORT-ONLY, deliberately NO
  // migrationFix ------------------------------------------------------------
  // Arming a watcher requires Claude Code's `Monitor` tool, which only the
  // AGENT can call — a hook/CLI process has no access to it. Registering a
  // migrationFix here would be a FAKE auto-fix: it would promise a repair
  // this process cannot actually perform. So this block only ever reports —
  // shipped/live state + the exact manual arm command — mirroring the reaper
  // REPORT-ONLY block above, never a `fixed`/`gated` action. Reuses
  // doctor-devswarm.js's own wakeMonitorShipped/wakeMonitorLiveCheck (never
  // re-derived here) so this can't drift from the doctor-diagnostic verdict.
  //
  // P2 fix: this block used to sit OUTSIDE gateOpen, unlike every other
  // DevSwarm repair in this file — so it spawned git (via wakeMonitorLiveCheck
  // -> resolveIdentity -> resolveMainWorktree) and told a non-DevSwarm user to
  // "arm it" on every `doctor --repair` run. Now behind the same gateOpen a
  // non-DevSwarm/non-git-worktree session already closes for every neighbouring
  // DevSwarm repair above — contract unchanged (still action:'none',
  // status:'skipped' either way, never 'gated'/'fixed').
  if (!gateOpen) {
    push('wake-monitor', 'none', 'skipped', 'wake-monitor not checked: not a DevSwarm session (or no resolvable git worktree) — nothing to arm here.');
  } else {
    try {
      const dsd = doctorDevswarmMod();
      if (typeof dsd.wakeMonitorShipped !== 'function' || typeof dsd.wakeMonitorLiveCheck !== 'function') {
        push('wake-monitor', 'none', 'skipped', 'wake-monitor check unavailable (doctor-devswarm.js missing expected exports)');
      } else {
        const shipped = dsd.wakeMonitorShipped(PLUGIN_ROOT);
        if (!shipped.shipped) {
          push('wake-monitor', 'none', 'skipped', 'wake-monitor not shipped: ' + shipped.reason + ' (cron fallback unaffected)');
        } else {
          const live = dsd.wakeMonitorLiveCheck(shipped.watcherMod, shipped.watcherPath, home, env, cwd);
          push('wake-monitor', 'none', 'skipped', live.message);
        }
      }
    } catch (e) {
      push('wake-monitor', 'none', 'skipped', 'wake-monitor check raised: ' + errMsg(e));
    }
  }

  // --- Install-vs-source integrity: REPORT-ONLY, UNGATED (not DevSwarm-
  // specific — applies to every install, unlike the wake-monitor block above).
  // CHECK 1 catches a cache dir for the running version whose on-disk content
  // silently diverged from the marketplace clone at the SAME version (syncCache
  // never overwrites an existing cache/<version>/ dir, so this never
  // self-heals). CHECK 2 reports whether the mechanical monitors.json arming
  // manifest is present in the INSTALLED root. Both reuse doctor-devswarm.js's
  // pure check functions so this can never drift from the doctor-diagnostic
  // verdict computed the same way. Never mutates anything under ~/.claude/**.
  try {
    const dsd = doctorDevswarmMod();
    if (typeof dsd.installDivergenceCheck !== 'function' || typeof dsd.monitorsJsonPresenceCheck !== 'function') {
      push('install-divergence', 'none', 'skipped', 'install-integrity checks unavailable (doctor-devswarm.js missing expected exports)');
    } else {
      const marketplaceRoot = typeof dsd.resolveMarketplaceDir === 'function' ? dsd.resolveMarketplaceDir(env, home) : null;
      const divergence = dsd.installDivergenceCheck({ installedRoot: PLUGIN_ROOT, marketplaceRoot, fsi: fs });
      push('install-divergence', 'none', 'skipped', divergence.message);
      const monitorsPresence = dsd.monitorsJsonPresenceCheck({ installedRoot: PLUGIN_ROOT, home, fsi: fs });
      push('monitors-json', 'none', 'skipped', monitorsPresence.message);
    }
  } catch (e) {
    push('install-divergence', 'none', 'skipped', 'install-integrity check raised: ' + errMsg(e));
  }

  return results;

  // ---- local: generic AUTO-SAFE migration fix ----------------------------
  function migrationFix(id, action, detect, apply) {
    try {
      const before = detect();
      if (!before.pending) { push(id, action, 'skipped', 'nothing to migrate'); return; }
      if (dryRun) { push(id, action, 'skipped', '[dry-run] would migrate: ' + (before.detail || 'pending')); return; }
      apply();
      const after = detect();
      if (!after.pending) push(id, action, 'fixed', 'migrated: ' + (before.detail || 'pending'));
      else push(id, action, 'failed', 'still pending after migrate: ' + (after.detail || ''));
    } catch (e) {
      push(id, action, 'failed', id + ' raised: ' + errMsg(e));
    }
  }
}

// ---------------------------------------------------------------------------
// checkMemguardReaperRisk({modPath, home}) -> {atRisk, message, file} | null.
// A user-machine reaper/memguard LaunchAgent (documented in this project's own
// operator notes, entirely OUTSIDE this repo) can SIGKILL any non-allowlisted
// `node` process once a process-count cap trips. A launchd-spawned ingest
// daemon's PPID is 1 by construction on macOS (launchd IS pid 1) — exactly
// what such a reaper's own "kill any remaining orphan (PPID==1) node process"
// pass targets — so an ingest daemon absent from that reaper's allowlist can
// be killed out from under a healthy install with no anti-hall-side signal at
// all. `modPath` defaults to install-devswarm-ingest.js — the REAL home of
// detectReaperGuard/reaperWarningLines (v0.65 memory-guard/reaper detection;
// that file's own comment says "doctor reuses these") — and is overridable
// ONLY for tests, so a fixture module can be exercised without ever touching
// that file. Fully defensive (typeof-checked + try/catch at every step) so an
// older build missing these exports degrades to silent (null), never a crash.
function checkMemguardReaperRisk(opts) {
  const o = opts || {};
  const modPath = o.modPath || INGEST_INSTALLER;
  let mod = null;
  try { mod = require(modPath); } catch (_) { return null; }
  if (typeof mod.detectReaperGuard !== 'function' || typeof mod.reaperWarningLines !== 'function') return null;
  let detection = null;
  try { detection = mod.detectReaperGuard({ home: o.home || os.homedir() }); } catch (_) { return null; }
  let lines = [];
  try { lines = mod.reaperWarningLines(detection) || []; } catch (_) { lines = []; }
  if (!lines.length) return null; // no action needed, or the helper itself declined — stay silent
  return { atRisk: true, message: lines.join('\n'), file: (detection && detection.file) || null };
}

module.exports = {
  readInstalledIngestWorkingDir, classifyIngestUnit, runRepairs,
  // Codex "is it wired" precise per-event detection (exported for direct unit
  // testing of the fixture-hooks.json upgrade scenario):
  scanCodex,
  // v0.57 mesh Phase 6 (D9/D25/D28) — legacy ingest unit orphan sweep:
  reapOrphanedLegacyUnits, projectDaemonHealthy,
  // v0.65.0 `doctor --reclaim-ingest-lock` (explicit, opt-in):
  reclaimIngestLocks, sweepOrphanedIngestLockFiles, reclaimCurrentProjectLock,
  // v0.65.0 memguard-reaper risk surfacing (report-only, defensive):
  checkMemguardReaperRisk,
  // v0.66 — "alive but ingesting nothing" (monitor-outcome) detection:
  monitorFaultFor, monitorFaultReason,
  MONITOR_FAILURE_FAIL_THRESHOLD, MONITOR_OK_STALE_MS,
};
