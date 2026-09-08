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
const MCP_REAPER_MOD       = path.join(PLUGIN_ROOT, 'companion', 'mcp-reaper.js');
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

// runIngestOrphanRepair({home, platform, dryRun, io}) ->
//   [{id, category, status, msg}]   status ∈ 'fixed' | 'skipped' | 'failed'
// v0.98 `doctor --repair-ingest-orphans [--apply]` (ec33954162ef): mirrors
// reclaimIngestLocks' shape — sweep (install-devswarm-ingest.js's own
// orphanReapPlan, never re-derived here) then apply (bootoutLoadedLabel /
// stopLoadedUnit) over ELIGIBLE entries only. Default is dry-run (prints the
// plan, calls nothing); `dryRun:false` actually unloads. EXPLICIT, OPT-IN
// ONLY — never called from runRepairs()'s default/--fix/--dry-run pass, only
// doctor.js's --repair-ingest-orphans flag calls it (matching
// reclaimIngestLocks' own posture exactly).
function runIngestOrphanRepair(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const platform = o.platform || process.platform;
  const dryRun = !!o.dryRun;
  const io = o.io;
  const results = [];
  const push = (id, category, status, msg) => results.push({ id, category, status, msg });

  if (platform !== 'darwin' && platform !== 'linux') {
    push('repair-ingest-orphans', 'repair-ingest-orphans', 'skipped', platform + ': no launchd/systemd orphan class on this platform — nothing to repair');
    return results;
  }

  const installer = ingestConst();
  if (typeof installer.orphanReapPlan !== 'function') {
    push('repair-ingest-orphans', 'repair-ingest-orphans', 'failed', 'install-devswarm-ingest.js does not export orphanReapPlan in this build — cannot safely repair, nothing touched');
    return results;
  }

  let plan = [];
  try { plan = installer.orphanReapPlan({ home, platform, io }); } catch (e) {
    push('repair-ingest-orphans', 'repair-ingest-orphans', 'failed', 'orphanReapPlan raised: ' + errMsg(e));
    return results;
  }

  const eligible = plan.filter((e) => e.eligible);
  if (eligible.length === 0) {
    push('repair-ingest-orphans', 'repair-ingest-orphans', 'skipped', plan.length === 0 ? 'no loaded ingest label found — nothing to repair' : 'zero eligible orphans (' + plan.length + ' loaded label(s), none eligible) — nothing to repair');
    return results;
  }

  for (const entry of eligible) {
    const name = entry.label || entry.unit || '(unknown)';
    const id = 'repair-ingest-orphan-' + name;
    if (dryRun) {
      const cmd = platform === 'darwin'
        ? `launchctl bootout gui/$(id -u)/${entry.label}`
        : `systemctl --user stop ${entry.unit}.service`;
      push(id, 'repair-ingest-orphans', 'skipped', '[dry-run] would run: ' + cmd + ' (class ' + entry.class + ')');
      continue;
    }
    let r = null;
    try {
      r = platform === 'darwin'
        ? installer.bootoutLoadedLabel(entry.label, { io })
        : installer.stopLoadedUnit(entry.unit, { io });
    } catch (e) { r = { error: e }; }
    const ok = !!(r && !r.error);
    push(id, 'repair-ingest-orphans', ok ? 'fixed' : 'failed',
      (ok ? 'unloaded ' : 'failed to unload ') + name + ' (class ' + entry.class + ')' + (r && r.error ? ' — ' + errMsg(r.error) : ''));
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

// compareSemverLite(a, b) -> -1/0/1. Tiny local numeric-prefix comparator —
// deliberately DUPLICATED from skills/update/scripts/update.js's own
// compareVersions (same 'unparseable/missing sorts as 0.0.0' behavior) rather
// than required from it, because update.js already requires THIS file
// (readInstalledIngestWorkingDir/classifyIngestUnit) — requiring it back would
// be a cycle.
function compareSemverLite(a, b) {
  const parse = (v) => {
    if (typeof v !== 'string') return [0];
    const m = v.trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)/);
    if (!m) return [0];
    return m[1].split('.').map((n) => parseInt(n, 10));
  };
  const pa = parse(a), pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// staleRunningCheck(home, repoKey, io) -> { stale, heartbeatVersion, installedVersion } | null
//
// Only meaningful once the caller has ALREADY confirmed cls==='ok' && alive
// (fresh heartbeat + live-pid lock + same incarnation, monitor OK) — this is a
// SEPARATE signal layered on top, same pattern as monitorFault (neither folds
// into classifyIngestUnit's install-SHAPE enum, both read from the daemon's own
// heartbeat file). Detects a daemon that is alive and well-formed but STILL
// RUNNING PRE-UPDATE CODE: `git pull` (update.js's own healIngestDaemon) lands
// new content at the stable ExecStart path, but the already-running process
// (devswarm-ingest.js's maxIterations:Infinity — only re-execs on crash) keeps
// executing whatever it loaded at its OWN startup until something restarts it.
//
// A missing heartbeat.codeVersion (a pre-this-fix daemon whose heartbeat
// predates the field — the forward-migration case) is treated as older than ANY
// real semver via compareSemverLite's 'missing sorts as 0.0.0' rule — the same
// "missing == stale, never == current" posture this codebase's persisted-shape
// migration discipline always takes.
//
// SELF-CLEARING (no bounce loop): after ONE restart the new incarnation stamps
// the CURRENT installed version into its own first heartbeat (devswarm-ingest.js
// resolves this ONCE per process, at startup), so this check reports
// stale:false on the very next doctor/update pass — nothing here re-triggers a
// second restart once the running process actually matches disk.
//
// Fail-open throughout: no repoKey, no heartbeat file yet, malformed JSON, or an
// unreadable/malformed installed plugin.json all return null (never claim
// stale on inconclusive evidence) rather than throwing.
function staleRunningCheck(home, repoKey, io) {
  if (!repoKey) return null;
  try {
    const daemon = ingestDaemonMod();
    if (typeof daemon.ingestHeartbeatPath !== 'function' || typeof daemon.readInstalledPluginVersion !== 'function') return null;
    const F = (io && io.fs) || fs;
    const raw = F.readFileSync(daemon.ingestHeartbeatPath(home, repoKey), 'utf8');
    const beat = JSON.parse(raw);
    const installedVersion = daemon.readInstalledPluginVersion(F);
    if (!installedVersion) return null; // can't establish "current" -> never claim stale
    const heartbeatVersion = (beat && beat.codeVersion != null) ? String(beat.codeVersion) : null;
    return { stale: compareSemverLite(heartbeatVersion, installedVersion) < 0, heartbeatVersion, installedVersion };
  } catch (_) { return null; }
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

  // devswarm-parent-gate.js stated-intent persisted-shape change: normalize
  // every gate-loop-state file to carry `intents`/`intentAcks`. Same posture
  // as migrate-reply-state above (a PURE per-user-file additive rewrite under
  // ~/.anti-hall/devswarm/parent-gate/, no daemon/scheduler side effect) ->
  // AUTO-SAFE. Reuses migrate-state.js's migrateGateIntents (itself
  // delegating to devswarm-gate-state.js) for BOTH the dry-run detect and the
  // apply — one code path, idempotent, fail-open, NO-DELETE. A courtesy
  // normalization, not a correctness prerequisite: the hook itself already
  // defaults a missing `intents`/`intentAcks` to `{}`/`0` on read.
  migrationFix('migrate-gate-intents', 'migrate-gate-intents', () => {
    const r = require(MIGRATE_STATE).migrateGateIntents({ dryRun: true, home });
    return { pending: !!(r && r.pending > 0), detail: (r && r.pending || 0) + ' gate-state file(s)' };
  }, () => require(MIGRATE_STATE).migrateGateIntents({ home }));

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

  // Spec item 5c / [E] UPDATE-TIME SELF-HEAL: fold-mesh-duplicates above only
  // folds the ONE project store `cwd` resolves to right now — an already-split
  // registry sitting in a DIFFERENT project's store on this same machine is
  // never reached just because `doctor` happened to run from project A instead
  // of B (the SkyCrew field report's split was found by direct store
  // inspection, not by a repair run from that project). Sweeps EVERY store
  // this machine has ever opened via devswarm.js's foldMeshDuplicatesAllStores
  // (same store.listStoreHashes(home) enumeration heal-registry-rows below
  // already uses), folding each directly by its stored hash. `foldMeshDuplicates`
  // (and therefore this all-stores wrapper, which just calls it per hash) DOES
  // support a real dry-run (ctx.dryRun), so this uses the same dual-detect
  // migrationFix() helper as fold-mesh-duplicates above rather than the manual
  // push()-based pattern heal-registry-rows uses (that one has no dry-run mode
  // of its own). Pure store read+write (forward-then-tombstone; message rows
  // NEVER deleted) -> AUTO-SAFE, same posture as fold-mesh-duplicates. Reuses
  // ONE code path for both detect and apply — idempotent (a re-run tombstones
  // nothing left in any store), fail-open (a single unreadable store is
  // skipped, never wiped, never aborts the sweep).
  migrationFix('fold-all-stores', 'fold-all-stores', () => {
    const dw = require(DEVSWARM_SCRIPT);
    if (typeof dw.foldMeshDuplicatesAllStores !== 'function') return { pending: false, detail: 'build has no foldMeshDuplicatesAllStores' };
    const r = dw.foldMeshDuplicatesAllStores(home, { cwd, env, dryRun: true }) || {};
    return {
      pending: (r.retired || 0) > 0,
      detail: (r.retired || 0) + ' duplicate mesh row(s) to fold across ' + (r.stores || 0) + ' store(s)'
        + (r.errors ? ' (' + r.errors + ' store error(s), fail-open)' : ''),
    };
  }, () => require(DEVSWARM_SCRIPT).foldMeshDuplicatesAllStores(home, { cwd, env }));

  // Orphan-partition self-heal: a partition with real messages but NO registry row
  // is structurally invisible to every fold path above (they all group
  // s.listRegistry() — an unregistered id is never a candidate). deriveSummary's
  // `orphans[]` already DETECTS this shape read-only; this HEALS it — adopting a
  // descriptor-backed orphan into the registry (purely additive, s.upsertRegistry)
  // and, when a live family exists, forwarding its unread into that family's
  // survivor. A descriptor-less orphan is left strictly alone (unhealable,
  // detect-and-report only — no worktree/family/owner to adopt it under). Pure
  // store read+write (no daemon/scheduler side effect) -> AUTO-SAFE, same posture
  // as fold-mesh-duplicates/fold-all-stores above. Reuses devswarm.js's
  // healOrphanPartitionsAllStores for BOTH the dry-run detect and the apply — one
  // code path, idempotent (a re-run finds the adopted id already registered, no
  // longer an orphan), fail-open. Guarded so an older devswarm.js build (missing
  // this export) degrades to a clean no-op rather than throwing.
  migrationFix('heal-orphan-partitions', 'heal-orphan-partitions', () => {
    const dw = require(DEVSWARM_SCRIPT);
    if (typeof dw.healOrphanPartitionsAllStores !== 'function') return { pending: false, detail: 'build has no healOrphanPartitionsAllStores' };
    const r = dw.healOrphanPartitionsAllStores(home, { cwd, env, dryRun: true }) || {};
    const n = (r.adopted || 0) + (r.forwarded || 0);
    return {
      pending: n > 0,
      // archivedDrained/archivedStale are reported for visibility but never count
      // toward `pending` — an archived-drained id has nothing to heal, and an
      // archived-stale id is deliberately left un-forwarded (age cap), not a
      // pending action. Both used to be folded into `unhealable`, which made a
      // scary-looking "N unhealable" number mostly just "already fine" (measured:
      // archived-drained was the single largest contributor on this machine).
      detail: (r.adopted || 0) + ' orphan partition(s) to adopt'
        + (r.forwarded ? ' + ' + r.forwarded + ' message(s) to forward' : '')
        + ' across ' + (r.stores || 0) + ' store(s), scope: all-stores'
        + (r.archivedDrained ? ' (' + r.archivedDrained + ' archived-drained, nothing to heal)' : '')
        + (r.archivedStale ? ' (' + r.archivedStale + ' archived-stale — past the age cap, detect-only)' : '')
        + (r.unhealable ? ' (' + r.unhealable + ' unhealable — no descriptor/family)' : '')
        + (r.errors ? ' (' + r.errors + ' store error(s), fail-open)' : ''),
    };
  }, () => require(DEVSWARM_SCRIPT).healOrphanPartitionsAllStores(home, { cwd, env }));

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

  // Archived-family DESCRIPTOR forward-migration — the descriptor-file half of the
  // same defect the pass above fixes for registry rows. cmdArchive used to tombstone
  // exactly ONE descriptor per archive, so a workspace registered under TWO ids (a
  // builder-UUID row and a slug row whose `sessionId` IS that UUID) kept its twin
  // LIVE in `workspaces/` after being archived — and a live descriptor is what
  // devswarm-parent-gate.js nags the Primary about, every turn, unclearably.
  // Grouping is the id/sessionId cross-link ONLY (never bare worktree equality), so
  // two legitimately-live tabs on one worktree are never retired. Pure descriptor
  // file read+write, NO-DELETE (bytes are tombstoned into archived/ first, and a
  // tombstone already holding different bytes is never clobbered) -> AUTO-SAFE, same
  // posture as fold-archived-rows above. One code path for detect and apply.
  migrationFix('fold-archived-family-descriptors', 'fold-archived-family-descriptors', () => {
    const dw = require(DEVSWARM_SCRIPT);
    if (typeof dw.foldArchivedFamilyDescriptors !== 'function') return { pending: false, detail: 'build has no foldArchivedFamilyDescriptors' };
    const r = dw.foldArchivedFamilyDescriptors(home, { cwd, env, dryRun: true }) || {};
    const n = r.pending || 0;
    // SAFETY REFUSALS ARE NOT A CLEAN NO-OP (P2). `left` carries every twin this
    // pass DECLINED to retire (worktree still live/unprovable, tombstone bytes
    // differ, lock busy, descriptor changed since the scan) and `ok:false` marks a
    // run that raised. Reporting only `pending` made all of those print as
    // "nothing to migrate". They are surfaced via `notice`, which migrationFix
    // renders on BOTH the pending and the not-pending path — a refusal must never
    // be indistinguishable from having nothing to do. They do NOT set `pending`:
    // apply cannot clear them, and claiming otherwise would make every run report
    // "still pending after migrate".
    const leftN = Array.isArray(r.left) ? r.left.length : 0;
    const errN = r.errors || 0;
    const notice = (leftN ? leftN + ' twin descriptor(s) left in place (safety-gated: '
        + r.left.map((x) => (x && x.reason) || 'unknown').join(', ') + ')' : '')
      + (errN ? (leftN ? '; ' : '') + errN + ' error(s)' : '')
      + (r.ok === false ? ((leftN || errN) ? '; ' : '') + 'pass did NOT complete: ' + (r.error || 'unknown') : '');
    return {
      pending: n > 0,
      detail: n + ' orphaned twin descriptor(s) of archived workspace(s) to retire',
      notice: notice || null,
    };
  }, () => require(DEVSWARM_SCRIPT).foldArchivedFamilyDescriptors(home, { cwd, env }));

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
      let repoKeyForHealth = null; // hoisted: reused below for the stale-running codeVersion check
      if (cls === 'ok') {
        repoKeyForHealth = read.repoKey;
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
        // STALE-RUNNING (pacing-fix delivery gap): install-SHAPE is fine and the
        // process is alive+healthy, but it may still be executing PRE-UPDATE code
        // — `git pull` (update.js) rewrites the stable ExecStart script on disk,
        // but the already-running daemon (maxIterations:Infinity, only re-execs on
        // crash) keeps running whatever it loaded at ITS OWN startup until
        // something restarts it. Detected here, not folded into classifyIngestUnit
        // (install-shape only) or daemonHealth (liveness only) — same layering as
        // monitorFault above. See staleRunningCheck for the self-clearing proof.
        const staleRunning = staleRunningCheck(home, repoKeyForHealth, o.io);
        if (staleRunning && staleRunning.stale) {
          const reason = 'ingest daemon is alive but running pre-update code (heartbeat codeVersion '
            + (staleRunning.heartbeatVersion || 'missing') + ', installed ' + staleRunning.installedVersion + ')';
          if (!gateOpen) {
            push('ingest', 'install-ingest', 'gated', reason + '. ' + gatedHint(CMD_INGEST));
          } else if (dryRun) {
            push('ingest', 'install-ingest', 'skipped', '[dry-run] would restart the ingest daemon so the running process picks up the current build (' + reason + ')');
          } else {
            spawnInstaller(INGEST_INSTALLER, [], cwd, env);
            push('ingest', 'install-ingest', 'fixed', 'ingest daemon restarted to pick up the current build — was running codeVersion '
              + (staleRunning.heartbeatVersion || 'missing') + ', now ' + staleRunning.installedVersion);
          }
        } else {
          push('ingest', 'install-ingest', 'skipped', 'ingest daemon installed and healthy (WorkingDirectory ' + read.workingDir + ')');
        }
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
        // P2 fix: cmdReconcile's returned object never carries a top-level
        // `.reason`/`.error` for a per-target-failure shape (only `.results[i]`
        // does) — a top-level `result.reason` exists ONLY for the early
        // `{ok:false, reason:'no-project'}` guard. Reading only the top level
        // discarded every real per-target cause and always printed "unknown
        // error". Surface the actual non-benign per-target errors instead —
        // benign skips (`locked`, `hivecontrolMissing`, `worktreeMissing`, the
        // same allow-list cmdReconcile itself uses for `ok`) are excluded so a
        // sweep failing ONLY on genuine causes never gets buried under skip
        // noise. Bounded to keep the doctor line readable on a large target list.
        const MAX_LISTED = 5;
        let detail = (result && result.reason) || null;
        if (!detail && result && Array.isArray(result.results)) {
          const real = result.results.filter((x) => x && !x.ok && !x.locked && !x.hivecontrolMissing && !x.worktreeMissing);
          if (real.length) {
            const shown = real.slice(0, MAX_LISTED).map((x) => x.id + ': ' + (x.error || 'unknown error'));
            const more = real.length > MAX_LISTED ? ' (+' + (real.length - MAX_LISTED) + ' more)' : '';
            detail = shown.join('; ') + more;
          }
        }
        push('reconcile', 'reconcile', 'failed', 'reconcile failed: ' + (detail || 'unknown error'));
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

  // --- R13 item 2: WIRE THE FOUR STANDALONE SWEEPS ------------------------
  //
  // sweepStaleDrainMarkers, promoteUnclaimedSessions, sweepReapedLogs and
  // sweepSendReceipts were written, exported and unit-tested — but NOTHING
  // called them. `doctor --repair` is the only surface that ever visits those
  // directories, so a stale drain marker silenced the parent gate forever, an
  // `unclaimed:` row stayed unclaimed forever, and the two append-only
  // diagnostic dirs grew without bound. Exported-but-unwired is not shipped.
  //
  // Each is AUTO-SAFE by its own contract (no daemon/scheduler side effect;
  // NO-DELETE except the two explicit retention sweeps, which delete only files
  // strictly older than their configured window and never touch a fresh one),
  // so they are NOT behind `gateOpen` — same posture as the migrationFix block
  // at the top of this function.
  //
  // MODE MAPPING IS THE WHOLE CONTRACT: `dryRun` -> mode 'check' (READ-ONLY,
  // reports only), otherwise mode 'repair' (applies). Every one of the four
  // honours that distinction internally; this passes it through and never
  // re-decides.
  {
    const sweepMode = dryRun ? 'check' : 'repair';
    const sweeps = [
      ['sweep-drain-markers', () => sweepStaleDrainMarkers({ home, mode: sweepMode, io: o.io })],
      ['promote-unclaimed', () => promoteUnclaimedSessions({ home, mode: sweepMode, cwd, env })],
      ['sweep-reaped-logs', () => sweepReapedLogs({ home, mode: sweepMode, env, io: o.io })],
      ['sweep-send-receipts', () => sweepSendReceipts({ home, mode: sweepMode, env, io: o.io })],
      ['sweep-sibling-watermarks', () => sweepOrphanedSiblingWatermarks({ home, mode: sweepMode, env, io: o.io })],
    ];
    for (const [id, fn] of sweeps) {
      let rows;
      try { rows = fn(); } catch (e) {
        push(id, 'none', 'failed', id + ' raised: ' + errMsg(e));
        continue;
      }
      const list = Array.isArray(rows) ? rows : [];
      const failed = list.filter((r) => r && r.status === 'failed');
      const acted = list.filter((r) => r && (r.status === 'fixed' || r.status === 'promoted'));
      if (failed.length) {
        push(id, sweepMode === 'repair' ? id : 'none', 'failed',
          failed.length + ' of ' + list.length + ' item(s) failed: ' + failed.map((r) => r.msg).filter(Boolean).join('; '));
        continue;
      }
      if (sweepMode === 'check') {
        push(id, 'none', 'skipped', list.length
          ? (list.length + ' item(s) pending (dry run — nothing touched)')
          : 'nothing pending');
        continue;
      }
      push(id, acted.length ? id : 'none', acted.length ? 'fixed' : 'skipped',
        acted.length ? (acted.length + ' item(s) handled') : 'nothing to do');
    }
  }

  return results;

  // ---- local: generic AUTO-SAFE migration fix ----------------------------
  function migrationFix(id, action, detect, apply) {
    try {
      const before = detect();
      // `notice` (optional): something the migration DECLINED to do or could not
      // complete. It never gates `pending` (apply cannot clear a safety refusal),
      // but it must never be swallowed either — a refusal reported as "nothing to
      // migrate" is the failure mode this plumbing exists to prevent.
      const note = (s) => (before.notice ? s + ' — ' + before.notice : s);
      if (!before.pending) { push(id, action, 'skipped', note('nothing to migrate')); return; }
      if (dryRun) { push(id, action, 'skipped', note('[dry-run] would migrate: ' + (before.detail || 'pending'))); return; }
      apply();
      const after = detect();
      const afterNote = (s) => (after.notice ? s + ' — ' + after.notice : s);
      if (!after.pending) push(id, action, 'fixed', afterNote('migrated: ' + (before.detail || 'pending')));
      else push(id, action, 'failed', afterNote('still pending after migrate: ' + (after.detail || '')));
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

// ---------------------------------------------------------------------------
// checkOrphanedMcpUnderBroker(opts) -> {atRisk, count, brokerCount, message} | null.
// REPORT-ONLY, defect bfa063ab8e3f: an app-server-style broker (any long-lived
// process that fans a request out into MCP-server children — the pattern is
// generic to that class of tool, not any one plugin) can leak MCP child
// processes across threads/sessions without reaping them on thread end. Those
// children are parented to the LIVE broker, not PID 1, so they are INVISIBLE
// by construction to a PPID==1 orphan reaper (this project's own mcp-reaper.js
// included — see its header) — that reaper's conservatism is correct, not a
// bug, so this check exists purely to surface what it structurally cannot see.
//
// Detection is by PROCESS SHAPE only, never a named plugin: reuse this
// project's own mcp-reaper.js signature matcher (matchesMcp/parsePs — pure,
// zero side effects to require()) to find MCP-signature processes, group them
// by live parent PID, and flag any parent with an abnormally large MCP child
// count. A parent absent from the snapshot (race) or itself PID-1-parented is
// skipped — same conservative "unsure -> skip" posture as mcp-reaper.
//
// THRESHOLD = 30. Reasoning: a single MCP client's mcp_servers config
// typically enumerates on the order of 5-15 servers; a couple of concurrent
// threads/sessions reusing one broker can plausibly multiply that into the
// several-dozen range under entirely normal operation. 30 sits comfortably
// above that normal band (roughly 2x a busy single-broker session) while
// remaining far below the 119-child leak this check exists to catch, so it
// will not fire on ordinary multi-thread use but will fire well before a leak
// reaches defect-report scale.
//
// Fully defensive: any missing platform support, absent `ps`, unparseable
// output, or thrown error yields null (silent). NEVER kills, signals, or
// writes anything — read-only `ps` enumeration only. Never gates doctor's
// pass/fail (callers only ever warnl() the message, exactly like
// checkMemguardReaperRisk above).
function checkOrphanedMcpUnderBroker(opts) {
  const o = opts || {};
  try {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return null;

    let mcpReaper;
    try { mcpReaper = require(o.mcpReaperModPath || MCP_REAPER_MOD); } catch (_) { return null; }
    if (typeof mcpReaper.parsePs !== 'function' || typeof mcpReaper.matchesMcp !== 'function') return null;

    let stdout;
    if (typeof o.psExec === 'function') {
      let r;
      try { r = o.psExec(); } catch (_) { return null; }
      if (!r || r.error || r.status !== 0 || r.signal) return null;
      stdout = r.stdout;
    } else {
      let r;
      try {
        r = cp.spawnSync('ps', ['-axo', 'pid=,ppid=,command='], {
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        });
      } catch (_) { return null; }
      if (!r || r.error || r.status !== 0 || r.signal) return null;
      stdout = r.stdout;
    }

    let procs;
    try { procs = mcpReaper.parsePs(stdout); } catch (_) { return null; }
    if (!Array.isArray(procs) || !procs.length) return null;

    const byPid = new Map();
    for (const p of procs) byPid.set(p.pid, p);

    const countByParent = new Map();
    for (const p of procs) {
      let isMcp = false;
      try { isMcp = mcpReaper.matchesMcp(p.cmd); } catch (_) { isMcp = false; }
      if (!isMcp) continue;
      if (!p.ppid || p.ppid === 1) continue; // PID-1 orphans are the OTHER reaper's job
      const parent = byPid.get(p.ppid);
      if (!parent) continue; // snapshot race: unsure -> skip (conservative, like mcp-reaper)
      countByParent.set(p.ppid, (countByParent.get(p.ppid) || 0) + 1);
    }

    const THRESHOLD = 30;
    const offenders = Array.from(countByParent.entries())
      .filter(([, n]) => n >= THRESHOLD)
      .sort((a, b) => b[1] - a[1]);
    if (!offenders.length) return null;

    const total = offenders.reduce((sum, [, n]) => sum + n, 0);
    const CAP = 5;
    const shown = offenders.slice(0, CAP).map(([pid, n]) => `pid ${pid} (${n} children)`);
    const more = offenders.length > CAP ? `, +${offenders.length - CAP} more broker(s)` : '';
    const message =
      `(warn) ${total} MCP-signature child process(es) found parented to ${offenders.length} ` +
      `live broker process(es): ${shown.join(', ')}${more}. These children have a LIVE parent ` +
      `(not PID 1), so a PPID==1 orphan reaper cannot see them by construction — this is upstream ` +
      `broker behavior, not anything for anti-hall or a local reaper to reap. If unexpected, restart ` +
      `the broker process to reclaim its children, and report the leak to whatever spawns it.`;

    return { atRisk: true, count: total, brokerCount: offenders.length, message };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// checkLeakedTestFixtureStores(opts) -> {atRisk, count, examples, message} | null.
// Wave D9, defect f3c1bc827d89: a test suite that spawns a real subprocess
// with `env: {...process.env}` and NO HOME/USERPROFILE override (see
// tests/hygiene/no-real-home-spawn.test.js for the general lint that now
// catches this at the source) leaks a fixture registry row into the
// DEVELOPER'S REAL `~/.anti-hall/devswarm/store/<repoKey>/` — confirmed on
// this machine as 88 such per-project store dirs, each holding exactly one row
// whose `worktreePath` pointed at a tmp dir the test long since deleted.
//
// DETECT-AND-REPORT ONLY, check mode included — per this project's hard rule
// (CLAUDE.md), NO automated deletion path exists here or anywhere else for
// this: a store dir flagged here is never touched, repaired, or removed by
// this function or by doctor's --fix pass. It only counts + samples so a human
// can decide (see docs/KB-devswarm-hivecontrol.md §38 for the manual cleanup
// command an OWNER can run after inspecting the listed examples).
//
// A store dir qualifies as a likely leaked test fixture when its registry has
// EXACTLY ONE row (a real project's store accumulates many rows over time;
// a fixture seeds exactly the one row the test needed) whose `worktreePath`
// is textually under a known tmp-dir prefix (os.tmpdir(), or the macOS-
// specific `/private/var/folders/`/`/var/folders/` real path a mkdtemp'd dir
// often canonicalizes to, or a bare `/tmp/`) AND no longer exists on disk
// (the test's own cleanup already removed it — a live worktree under a tmp
// prefix, e.g. a deliberately tmp-rooted real project, is NOT flagged).
//
// Fully defensive: any missing store module, unreadable store root, or a
// per-store read/open error is skipped (never thrown) — same fail-open
// posture as every other check in this file. `storeModPath`/`home` are
// injectable for tests only.
function checkLeakedTestFixtureStores(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  let storeMod;
  try { storeMod = require(o.storeModPath || DEVSWARM_STORE); } catch (_) { return null; }
  if (typeof storeMod.listStoreHashes !== 'function' || typeof storeMod.openStore !== 'function') return null;

  let hashes = [];
  try { hashes = storeMod.listStoreHashes(home) || []; } catch (_) { return null; }
  if (!hashes.length) return null;

  const tmpDir = os.tmpdir();
  function looksLikeTmpFixturePath(p) {
    if (typeof p !== 'string' || !p) return false;
    return p.startsWith(tmpDir)
      || p.startsWith('/private/var/folders/')
      || p.startsWith('/var/folders/')
      || p.startsWith('/tmp/');
  }

  const examples = [];
  let count = 0;
  for (const hash of hashes) {
    let registry = null;
    let s = null;
    try {
      s = storeMod.openStore({ home, hash, backend: o.backend, env: o.env });
      registry = s.listRegistry();
    } catch (_) { registry = null; } finally {
      if (s) { try { s.close(); } catch (_) { /* best-effort */ } }
    }
    if (!Array.isArray(registry) || registry.length !== 1) continue;
    const row = registry[0];
    const wt = row && row.worktreePath;
    if (!looksLikeTmpFixturePath(wt)) continue;
    let exists = true;
    try { exists = fs.existsSync(wt); } catch (_) { exists = true; }
    if (exists) continue; // a genuinely live tmp-rooted project — not a leak
    count++;
    if (examples.length < 5) examples.push({ hash, worktreePath: wt });
  }
  if (count === 0) return null;

  const shown = examples.map((e) => `${e.hash} -> ${e.worktreePath}`).join(', ');
  const more = count > examples.length ? `, +${count - examples.length} more` : '';
  const message =
    `(warn) leaked test-fixture stores: ${count} (repair does not delete; see docs). ` +
    `Examples: ${shown}${more}.`;
  return { atRisk: true, count, examples, message };
}

// ---------------------------------------------------------------------------
// checkEscalatedWhileAlive(opts) -> {atRisk, count, examples, message} | null.
// D12 (v0.96.1) false-positive escalation — a liveness file can carry
// `status: 'escalated'` for a row whose session pid is PROVABLY alive right
// now (the supervisor's stale-vs-dormant threshold mismatch this release
// fixes at the call site). liveness.js's computeLiveness now self-heals this
// on the row's NEXT supervisor pass (clears `escalated` when isSessionAliveRow
// is true, logged to recovery.log with reason `session-alive`) — so between
// "escalated written" and "next supervisor pass" a human reading doctor's
// output should be told it will self-heal, not just that it is escalated.
//
// DETECT-AND-REPORT ONLY: this never writes, clears, or kills anything —
// mirrors checkMemguardReaperRisk/checkOrphanedMcpUnderBroker/
// checkLeakedTestFixtureStores' pure-diagnostic posture above. Fully
// defensive: a missing supervisor/liveness module, an unreadable descriptor
// list, or a malformed/missing liveness file for any one row is skipped
// (never thrown) — same fail-open posture as every other check in this file.
function checkEscalatedWhileAlive(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const F = o.fs || fs;
  try {
    let readDescriptors;
    let liveness;
    try {
      ({ readDescriptors } = require(path.join(PLUGIN_ROOT, 'companion', 'devswarm-supervisor.js')));
      liveness = require(path.join(PLUGIN_ROOT, 'companion', 'lib', 'liveness.js'));
    } catch (_) { return null; }
    if (typeof readDescriptors !== 'function'
      || typeof (liveness && liveness.isSessionAliveRow) !== 'function'
      || typeof (liveness && liveness.livenessPathFor) !== 'function') return null;

    let descs = [];
    try { descs = readDescriptors(home) || []; } catch (_) { return null; }
    if (!Array.isArray(descs) || !descs.length) return null;

    const examples = [];
    for (const d of descs) {
      if (!d || d.id == null) continue;
      let verdict = null;
      try { verdict = JSON.parse(F.readFileSync(liveness.livenessPathFor(d.id, home), 'utf8')); } catch (_) { continue; }
      if (!verdict || verdict.status !== 'escalated') continue;
      let alive = false;
      try { alive = liveness.isSessionAliveRow(d, home, { fs: F }); } catch (_) { alive = false; }
      if (!alive) continue;
      examples.push(String(d.id));
    }
    if (!examples.length) return null;

    const CAP = 5;
    const shown = examples.slice(0, CAP);
    const more = examples.length > CAP ? `, +${examples.length - CAP} more` : '';
    const message =
      `(warn) ${examples.length} workspace(s) escalated while session alive (self-heals next ` +
      `supervisor pass): ${shown.join(', ')}${more}.`;
    return { atRisk: true, count: examples.length, examples, message };
  } catch (_) {
    return null;
  }
}

// checkSupersededArchivedMarkers(opts) -> {atRisk, count, examples, message} | null.
// P0 (field, 0.96.1/0.96.2) — a Primary's own ANCHOR row (worktree == repo
// root, id REUSED after a prior workspace at that same root was archived and
// put away) can still carry archived/<id>.json from that PRIOR occupant.
// devswarm-archived.js's isArchivedWorkspace now discriminates this by
// sessionId (archived marker's own sessionId vs. the live workspaces/<id>.json
// descriptor's), so the live row itself is no longer misclassified — this is
// the doctor-side VISIBILITY half: surface every id where that discriminator
// actually fired, so an operator can see which reused ids carry a superseded
// marker, without ever touching the marker file.
//
// DETECT-AND-REPORT ONLY, same posture as checkEscalatedWhileAlive above:
// this never writes, clears, or deletes any archived/<id>.json — a superseded
// marker is inert (isArchivedWorkspace already ignores it), so there is
// nothing that NEEDS repairing, only something worth knowing about. Fully
// fail-open: a missing devswarm-archived.js module, unreadable archived/ dir,
// or a malformed record for any one id is skipped, never thrown.
function checkSupersededArchivedMarkers(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const F = o.fs || fs;
  try {
    let archivedLib;
    try { archivedLib = require(path.join(PLUGIN_ROOT, 'companion', 'lib', 'devswarm-archived.js')); } catch (_) { return null; }
    if (typeof archivedLib.devswarmRoot !== 'function' || typeof archivedLib.realSid !== 'function'
      || typeof archivedLib.readLiveSessionId !== 'function' || typeof archivedLib.isSafeId !== 'function') return null;

    const root = archivedLib.devswarmRoot(home);
    const archivedDir = path.join(root, 'archived');
    let entries = [];
    try { entries = F.readdirSync(archivedDir); } catch (_) { return null; }
    if (!Array.isArray(entries) || !entries.length) return null;

    const examples = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!archivedLib.isSafeId(id)) continue;
      let desc = null;
      try { desc = JSON.parse(F.readFileSync(path.join(archivedDir, name), 'utf8')); } catch (_) { continue; }
      if (!desc || typeof desc !== 'object') continue;
      const markerSid = archivedLib.realSid(desc.sessionId);
      if (!markerSid) continue;
      const liveSid = archivedLib.readLiveSessionId(root, id, F);
      if (liveSid && liveSid !== markerSid) examples.push(id);
    }
    if (!examples.length) return null;

    const CAP = 5;
    const shown = examples.slice(0, CAP);
    const more = examples.length > CAP ? `, +${examples.length - CAP} more` : '';
    const message =
      `(info) ${examples.length} archived marker(s) superseded by a live descriptor with a different ` +
      `session id (previous occupant of a reused id — inert, no action needed): ${shown.join(', ')}${more}.`;
    return { atRisk: true, count: examples.length, examples, message };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// sweepStaleDrainMarkers({home, mode, io}) -> array of result rows.
//
// R11 Auditor Q5 (P1): devswarm-parent-gate.js's Stop-hook consumer only ever
// clears a stale in-flight drain marker (companion/lib/devswarm-drain-marker.js)
// for `own.id` — the CALLING Primary's own worktree-derived id — because it
// observes a marker only as a side effect of gating ITS OWN unread on ITS OWN
// Stop pass. A marker written under any OTHER id (e.g. a Primary whose
// worktree later moved/was removed, or one that crashed before its NEXT own
// Stop pass ever ran to notice its own stale marker) has nothing else that
// ever visits ~/.anti-hall/devswarm/drain/ to clean it up — it lingers
// forever once its 10-minute TTL has passed. This sweep enumerates every
// marker file in that directory directly and applies devswarm-drain-marker.js's
// OWN staleness test (readDrainMarker's TTL, via clearStaleDrainMarker) —
// never reimplementing the TTL/staleness logic here, same "one derivation,
// never three" discipline as every other repair in this file.
//
// mode 'check' (default): READ-ONLY. Lists every marker with {id, ageMs,
// stale} — never deletes anything, mirroring listIngestLockFiles's dry-run
// preview posture above.
// mode 'repair': deletes ONLY markers devswarm-drain-marker.js itself calls
// stale (via clearStaleDrainMarker — the SAME primitive the gate's own Stop-hook
// consumer uses to clear a stale marker it happens to observe). A FRESH marker
// is NEVER removed under any circumstance — this must never race a legitimately
// in-flight drain and delete out from under it. A missing drain/ directory
// (ENOENT) is a routine no-op (nothing has ever drained yet for this HOME),
// never a failure.
function sweepStaleDrainMarkers(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const mode = o.mode === 'repair' ? 'repair' : 'check';
  const io = o.io || {};
  const F = io.fs || fs;
  const now = Number.isFinite(io.now) ? io.now : Date.now();

  let drainMarker;
  try {
    drainMarker = require(path.join(PLUGIN_ROOT, 'companion', 'lib', 'devswarm-drain-marker.js'));
  } catch (e) {
    return [{ id: null, ageMs: null, stale: null, status: 'failed', msg: 'devswarm-drain-marker.js could not be loaded: ' + errMsg(e) }];
  }
  if (typeof drainMarker.readDrainMarker !== 'function' || typeof drainMarker.clearStaleDrainMarker !== 'function') {
    return [{ id: null, ageMs: null, stale: null, status: 'failed', msg: 'devswarm-drain-marker.js does not export readDrainMarker/clearStaleDrainMarker in this build — cannot safely sweep, nothing touched' }];
  }

  const dir = path.join(devswarmRootFor(home), 'drain');
  let names = [];
  try {
    names = F.readdirSync(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return []; // routine no-op: nothing has ever drained yet
    return [{ id: null, ageMs: null, stale: null, status: 'failed', msg: 'could not list ' + dir + ': ' + errMsg(e) }];
  }

  const results = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);

    let marker;
    try {
      marker = drainMarker.readDrainMarker(home, id, { now });
    } catch (e) {
      results.push({ id, ageMs: null, stale: null, status: 'failed', msg: 'unsafe or unreadable marker id ' + JSON.stringify(id) + ': ' + errMsg(e) });
      continue;
    }
    if (!marker) continue; // unreadable/malformed -> readDrainMarker's own fail-soft "no marker"; nothing to report or sweep
    const ageMs = now - marker.startedAt;

    if (mode === 'check') {
      results.push({ id, ageMs, stale: marker.stale });
      continue;
    }

    // repair mode: NEVER touch a fresh marker.
    if (!marker.stale) {
      results.push({ id, ageMs, stale: false, status: 'skipped', msg: 'marker ' + id + ' is fresh — left untouched' });
      continue;
    }
    let cleared = false;
    try { cleared = drainMarker.clearStaleDrainMarker(home, id, { now }); } catch (_) { cleared = false; }
    results.push({
      id, ageMs, stale: true,
      status: cleared ? 'fixed' : 'failed',
      msg: cleared ? ('removed stale drain marker ' + id + ' (age ' + ageMs + 'ms)') : ('failed to remove stale drain marker ' + id),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// promoteUnclaimedSessions({home, mode, cwd, env}) -> array of result rows.
//
// The DOCTOR half of the `unclaimed:<id>` forward migration (carry-out (e)); the
// UPDATE half is skills/update/scripts/update.js's promoteUnclaimedPostUpdate.
// Both delegate to the SAME devswarm.js primitive
// (promoteUnclaimedRegistrySessions) so the two paths can never disagree about
// what is safe to promote — this file adds no decision logic of its own.
//
// mode 'check' (default): READ-ONLY — reports which rows still carry the
// synthetic marker and whether a real session id is discoverable for them.
// mode 'repair': performs the promotion. NO-DELETE in every mode: the only
// change ever made is replacing one field's value on a row that has an
// independently-known real session id; a row without one is left exactly as it
// is. Idempotent and fail-open — a build without the primitive, or a throw,
// reports a row and touches nothing.
function promoteUnclaimedSessions(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const mode = o.mode === 'repair' ? 'repair' : 'check';

  let devswarm;
  try {
    devswarm = require(path.join(PLUGIN_ROOT, 'scripts', 'devswarm.js'));
  } catch (e) {
    return [{ id: null, status: 'failed', msg: 'devswarm.js could not be loaded: ' + errMsg(e) }];
  }
  if (typeof devswarm.promoteUnclaimedRegistrySessions !== 'function') {
    return [{ id: null, status: 'failed', msg: 'devswarm.js does not export promoteUnclaimedRegistrySessions in this build — nothing touched' }];
  }

  if (mode === 'check') {
    // A pure listing: readDescriptors + the marker test, with NO write. The
    // primitive itself always writes when it can, so check mode must not call
    // it — it re-derives only the (trivial) marker predicate here.
    let readDescriptors;
    try {
      ({ readDescriptors } = require(path.join(PLUGIN_ROOT, 'companion', 'devswarm-supervisor.js')));
    } catch (e) {
      return [{ id: null, status: 'failed', msg: 'devswarm-supervisor.js could not be loaded: ' + errMsg(e) }];
    }
    let descs = [];
    try { descs = readDescriptors(home) || []; } catch (e) { return [{ id: null, status: 'failed', msg: 'could not read descriptors: ' + errMsg(e) }]; }
    const rows = [];
    for (const d of descs) {
      if (!d || d.id == null) continue;
      if (String(d.sessionId) !== 'unclaimed:' + String(d.id)) continue;
      rows.push({ id: String(d.id), status: 'pending', msg: 'workspace ' + String(d.id) + ' still carries the synthetic unclaimed: session marker' });
    }
    return rows;
  }

  let r;
  try { r = devswarm.promoteUnclaimedRegistrySessions(home, { cwd: o.cwd, env: o.env }) || {}; }
  catch (e) { return [{ id: null, status: 'failed', msg: 'promote sweep raised: ' + errMsg(e) }]; }
  const rows = [];
  for (const p of (r.promoted || [])) {
    rows.push({ id: String(p.id), status: 'fixed', msg: 'promoted ' + String(p.id) + ' from the unclaimed: marker to its real session id' });
  }
  for (const l of (r.left || [])) {
    rows.push({ id: String(l.id), status: 'skipped', msg: 'left ' + String(l.id) + ' as is (' + String(l.reason) + ') — never guessed, never deleted' });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// RETENTION SWEEPS (R12 hygiene). Two append-only directories under the
// devswarm root grow without bound because nothing has ever deleted from them:
//   reaped/*.ndjson      — `reap-orphans` audit trails
//   send-receipts/<day>/ — cmdSend delivery receipts (v0.90.0)
// Both are pure diagnostics: nothing reads a reaped log after the run that
// wrote it, and a receipt is only consulted by the reply tracker within the
// same turn. sweepAgedFiles is the ONE implementation both use.
//
// mode 'check' LISTS candidates and deletes nothing. mode 'repair' deletes ONLY
// files whose mtime is older than the retention window — the window is read
// from the caller-supplied env var name so each sweep keeps its own tunable,
// and an unparseable/absent value falls back to the default (a typo must never
// widen a deletion window). A missing directory is a routine no-op.
function retentionDays(env, varName, fallbackDays) {
  const raw = (env || process.env)[varName];
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallbackDays;
}

function sweepAgedFiles(opts) {
  const o = opts || {};
  const mode = o.mode === 'repair' ? 'repair' : 'check';
  const F = (o.io && o.io.fs) || fs;
  const now = Number.isFinite(o.io && o.io.now) ? o.io.now : Date.now();
  const maxAgeMs = o.days * 24 * 60 * 60 * 1000;
  const results = [];

  const walk = (dir, depth) => {
    let names = [];
    try { names = F.readdirSync(dir); } catch (e) {
      if (e && e.code === 'ENOENT') return; // routine: nothing has ever been written here
      results.push({ file: dir, status: 'failed', msg: 'could not list ' + dir + ': ' + errMsg(e) });
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try { st = F.statSync(full); } catch (_) { continue; } // vanished mid-sweep: nothing to do
      if (st.isDirectory()) {
        // One level of date-partitioning (send-receipts/<YYYY-MM-DD>/) is the
        // only nesting either directory has; bounded so a symlink loop or an
        // unexpected deep tree can never make this walk unbounded.
        if (depth < 1) walk(full, depth + 1);
        continue;
      }
      if (o.suffix && !name.endsWith(o.suffix)) continue;
      const ageMs = now - st.mtimeMs;
      if (ageMs <= maxAgeMs) continue; // inside the retention window — NEVER touched
      if (mode === 'check') {
        results.push({ file: full, ageMs, status: 'pending', msg: full + ' is older than ' + o.days + ' day(s)' });
        continue;
      }
      try {
        F.unlinkSync(full);
        results.push({ file: full, ageMs, status: 'fixed', msg: 'removed ' + full + ' (age ' + Math.round(ageMs / 86400000) + 'd)' });
      } catch (e) {
        results.push({ file: full, ageMs, status: 'failed', msg: 'could not remove ' + full + ': ' + errMsg(e) });
      }
    }
  };
  walk(o.dir, 0);
  return results;
}

const REAPED_RETENTION_DAYS_DEFAULT = 30;
const SEND_RECEIPT_RETENTION_DAYS_DEFAULT = 7;

// sweepReapedLogs({home, mode, env, io}) — retention sweep for
// <devswarmRoot>/reaped/*.ndjson. Window: ANTIHALL_DEVSWARM_REAPED_RETENTION_DAYS
// (default 30 days).
function sweepReapedLogs(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  return sweepAgedFiles({
    dir: path.join(devswarmRootFor(home), 'reaped'),
    suffix: '.ndjson',
    days: retentionDays(o.env, 'ANTIHALL_DEVSWARM_REAPED_RETENTION_DAYS', REAPED_RETENTION_DAYS_DEFAULT),
    mode: o.mode, io: o.io,
  });
}

// sweepSendReceipts({home, mode, env, io}) — retention sweep for
// <devswarmRoot>/send-receipts/<YYYY-MM-DD>/*.json. Window:
// ANTIHALL_DEVSWARM_SEND_RECEIPT_RETENTION_DAYS (default 7 days) — short
// because a receipt's only reader (devswarm-parent-reply-tracker.js) consults
// it within the same turn it was written.
function sweepSendReceipts(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  return sweepAgedFiles({
    dir: path.join(devswarmRootFor(home), 'send-receipts'),
    suffix: '.json',
    days: retentionDays(o.env, 'ANTIHALL_DEVSWARM_SEND_RECEIPT_RETENTION_DAYS', SEND_RECEIPT_RETENTION_DAYS_DEFAULT),
    mode: o.mode, io: o.io,
  });
}

// sweepOrphanedSiblingWatermarks({home, mode, io}) — R14 F3 (P3) hygiene for
// the LIVE-SIBLING WATERMARK files (`cursors/<callerId>.seen-<siblingId>.json`,
// scripts/devswarm.js).
//
// WHY THIS IS NOT AN AGE SWEEP: a watermark is a READ POSITION, not a log line.
// An old one is not stale — it is exactly as load-bearing on day 90 as on day 1
// (dropping it re-delivers that sibling's whole backlog to its caller). The one
// thing that genuinely retires a watermark is its SUBJECT ceasing to exist, so
// the test is existence, not age: the sibling id has NO registry row in ANY of
// this machine's stores AND NO messages in any partition under that id. Both
// legs must be empty; either one present means someone can still read it.
//
// Watermarks whose file name this module cannot unambiguously parse are SKIPPED
// (parseSiblingSeenCursorName returns null) — guessing a caller/sibling split
// and then deleting on the guess is exactly the mis-parse the name tightening
// exists to prevent.
//
// FAIL-SOFT AND FAIL-CLOSED: any error enumerating stores leaves `known` as a
// SUPERSET-unknown and the sweep reports itself as skipped rather than deleting
// on incomplete evidence — an unreadable store must never look like an absent
// sibling.
function sweepOrphanedSiblingWatermarks(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const mode = o.mode === 'repair' ? 'repair' : 'check';
  const F = (o.io && o.io.fs) || fs;
  const results = [];

  let cli = null;
  try { cli = require(path.join(PLUGIN_ROOT, 'scripts', 'devswarm.js')); } catch (_) { cli = null; }
  if (!cli || typeof cli.parseSiblingSeenCursorName !== 'function') {
    return [{ file: 'cursors', status: 'skipped', msg: 'watermark name parser unavailable — nothing swept' }];
  }

  const dir = path.join(devswarmRootFor(home), 'cursors');
  let names = [];
  try { names = F.readdirSync(dir); } catch (e) {
    if (e && e.code === 'ENOENT') return results; // routine: no cursors dir yet
    return [{ file: dir, status: 'failed', msg: 'could not list ' + dir + ': ' + errMsg(e) }];
  }
  const candidates = [];
  for (const name of names) {
    const parsed = cli.parseSiblingSeenCursorName(name);
    if (!parsed) continue;
    candidates.push({ name, full: path.join(dir, name), siblingId: parsed.siblingId, callerId: parsed.callerId });
  }
  if (candidates.length === 0) return results;

  // Build the "still reachable" id set across EVERY store on this machine.
  const known = new Set();
  let enumerationComplete = true;
  let storeMod = null;
  try { storeMod = require(DEVSWARM_STORE); } catch (_) { storeMod = null; enumerationComplete = false; }
  let hashes = [];
  if (storeMod) {
    try { hashes = storeMod.listStoreHashes(home) || []; } catch (_) { enumerationComplete = false; }
  }
  let registryRowsSeen = 0;
  for (const hash of hashes) {
    let s = null;
    // `env` MUST be forwarded: the backend is chosen from it
    // (devswarm-store.js selectBackend), and opening a journal-backed store
    // under the sqlite default yields an EMPTY registry — which this sweep
    // would otherwise read as "every sibling is gone" and act on. Observed
    // live while building this sweep, not hypothesized.
    try { s = storeMod.openStore({ home, hash, env: o.env }); } catch (_) { enumerationComplete = false; continue; }
    try {
      for (const row of s.listRegistry() || []) { if (row && row.id != null) { known.add(String(row.id)); registryRowsSeen++; } }
      for (const c of candidates) {
        if (known.has(c.siblingId)) continue;
        try { if (s.messageCount(c.siblingId) > 0) known.add(c.siblingId); } catch (_) { enumerationComplete = false; }
      }
    } catch (_) { enumerationComplete = false; } finally { try { s.close(); } catch (_) {} }
  }
  // A TOTALLY EMPTY registry across every store, while watermark files exist,
  // is far more likely a read failure (wrong backend, unreadable store) than a
  // machine on which every workspace genuinely vanished. Decline rather than
  // delete on that reading — the second half of the same fail-closed posture.
  if (registryRowsSeen === 0) {
    return [{ file: dir, status: 'skipped', msg: 'no registry rows readable in any store — watermark sweep declined (never deletes on an empty read)' }];
  }
  if (!enumerationComplete) {
    return [{ file: dir, status: 'skipped', msg: 'store enumeration incomplete — watermark sweep declined (never deletes on partial evidence)' }];
  }

  for (const c of candidates) {
    if (known.has(c.siblingId)) continue;
    if (mode === 'check') {
      results.push({ file: c.full, status: 'pending', msg: c.full + ' names sibling ' + c.siblingId + ', which has no registry row and no partition' });
      continue;
    }
    try {
      F.unlinkSync(c.full);
      results.push({ file: c.full, status: 'fixed', msg: 'removed orphaned watermark ' + c.name + ' (sibling ' + c.siblingId + ' no longer exists)' });
    } catch (e) {
      results.push({ file: c.full, status: 'failed', msg: 'could not remove ' + c.full + ': ' + errMsg(e) });
    }
  }
  return results;
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
  // v0.98 `doctor --repair-ingest-orphans [--apply]` (explicit, opt-in; ec33954162ef):
  runIngestOrphanRepair,
  // v0.65.0 memguard-reaper risk surfacing (report-only, defensive):
  checkMemguardReaperRisk,
  // broker-parented MCP-orphan-leak surfacing (report-only, defensive; defect bfa063ab8e3f):
  checkOrphanedMcpUnderBroker,
  // Wave D9 — leaked test-fixture store detection (report-only, NO deletion path; defect f3c1bc827d89):
  checkLeakedTestFixtureStores,
  // D12 — escalated-while-session-alive detection (report-only, self-heals via liveness.js):
  checkEscalatedWhileAlive,
  // D12d — superseded archived-marker detection (report-only, inert once isArchivedWorkspace discriminates it):
  checkSupersededArchivedMarkers,
  // v0.66 — "alive but ingesting nothing" (monitor-outcome) detection:
  monitorFaultFor, monitorFaultReason,
  MONITOR_FAILURE_FAIL_THRESHOLD, MONITOR_OK_STALE_MS,
  // stale-running (pacing-fix delivery gap) detection:
  staleRunningCheck, compareSemverLite,
  // R11 Auditor Q5 — sweep drain markers left under OTHER ids that the gate's
  // own Stop-hook consumer never visits:
  sweepStaleDrainMarkers,
  // carry-out (e) — doctor half of the `unclaimed:<id>` forward migration:
  promoteUnclaimedSessions,
  // R12 hygiene — bounded retention for the two append-only diagnostic dirs:
  sweepAgedFiles, sweepReapedLogs, sweepSendReceipts,
  // R14 F3 — existence-based (never age-based) hygiene for sibling watermarks:
  sweepOrphanedSiblingWatermarks,
  REAPED_RETENTION_DAYS_DEFAULT, SEND_RECEIPT_RETENTION_DAYS_DEFAULT,
};
