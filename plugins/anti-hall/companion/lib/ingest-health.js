'use strict';
// anti-hall :: ingest-health — Phase 7 shared per-project ingest-daemon health
// check (PLAN-v0.57-mesh.md D25). Used by BOTH per-turn hooks
// (devswarm-parent-inbox.js, devswarm-child-turn.js — the stale-data banner)
// AND devswarm.js's send-time self-heal wrapper, so every consumer agrees on a
// single definition of "the daemon is alive".
//
// HEALTH = RUNNING + HEALTHY, NOT freshness-only (D25). A fresh heartbeat file
// alone is not proof the daemon is alive (a dead process can leave a
// fresh-looking file within the staleness window, e.g. a crash right after its
// last write); a live process can also have a missing/never-written heartbeat
// (freshly installed, first sweep not yet run). daemonHealth() therefore reports
// on TWO INDEPENDENT signals, both fs-only:
//   (1) heartbeat freshness  — heartbeats/ingest-<repoKey>.json,
//       `now - ts <= HEARTBEAT_STALE_MS`.
//   (2) lock/process evidence — the per-project O_EXCL ingest lock
//       (locks/ingest-project-<repoKey>.lock, devswarm-ingest.js's
//       ingestLockPath project shape) is held by a LIVE pid.
// BOTH must hold for 'healthy'. A missing or unparsable heartbeat/lock file is
// NOT-fresh / NOT-live respectively — fail-open means "never throw", NEVER
// "assume healthy" (D25 fixes exactly this "missing == healthy" contradiction).
//
// v0.66 MONITOR-OUTCOME FAULT: BOTH signals above can hold (fresh heartbeat,
// live-pid lock, same incarnation — otherwise 'healthy') while the daemon's
// `hivecontrol workspace monitor` spawn fails every cycle (a permanent config
// fault, e.g. ENOENT/EACCES/ENOTDIR) — alive, but ingesting NOTHING. Reported
// as its own status:'failed' (see daemonHealth below), reusing hooks/lib/
// doctor-repair.js's EXPORTED monitorFaultFor() (same thresholds, same
// missing-fields=UNKNOWN rule — never duplicated here) so the hot-path banner
// and doctor's repair verdict can never drift apart.
//
// WINDOWS CARVE-OUT (D28): the ingest installer is a documented no-op on win32
// (install-devswarm-ingest.js), so the daemon heartbeat is NEVER fresh there.
// `daemonHealth` short-circuits to `status:'unsupported'` on win32 so callers
// render NO stale-banner spam and attempt NO futile per-turn/per-send installer
// spawn on a platform that structurally cannot run the daemon.
//
// PURE FS ON THE HOT PATH — no spawn, no git, here. `repoKey` is resolved by
// the CALLER (e.g. `repokeyForWorktree(cwd)`, which DOES spawn `git`); that
// cost is the caller's own documented choice (once per turn / once per send),
// never hidden inside this helper.
//
// Deliberately does NOT require devswarm-ingest.js / install-devswarm-ingest.js
// (both pull in the store + spawnSync + scheduler-unit code, far heavier than a
// helper meant to be LAZILY required inside two per-turn hot-path hooks should
// depend on — same rationale already documented in devswarm-child-turn.js's
// defaultInboxPath/defaultCursorPath comment). The two path-format functions
// below are a deliberate small duplication of devswarm-ingest.js's own
// `ingestHeartbeatPath`/`ingestLockPath` (project shape), mirrored byte-for-byte.
//
// Every fs/process call is injectable via `opts.io` ({ fs, isAlive }) so tests
// exercise both D25 failure modes deterministically, without depending on a
// real OS pid's liveness.

const fs = require('fs');
const path = require('path');

const HEARTBEAT_STALE_MS = 3 * 60 * 1000; // mirrors devswarm-parent-inbox.js's own constant

function devswarmRoot(home) {
  return path.join(home, '.anti-hall', 'devswarm');
}

// ingestHeartbeatPath(home, repoKey) — mirrors devswarm-ingest.js's own
// ingestHeartbeatPath(home, hash) byte-for-byte (heartbeats/ingest-<hash>.json).
function ingestHeartbeatPath(home, repoKey) {
  return path.join(devswarmRoot(home), 'heartbeats', 'ingest-' + String(repoKey) + '.json');
}

// ingestProjectLockPath(home, repoKey) — mirrors devswarm-ingest.js's
// ingestLockPath's PER-PROJECT shape (locks/ingest-project-<repoKey>.lock) —
// the shape written once `repoKey` resolves, NOT the legacy per-worktree
// `locks/ingest-<hash>.lock` shape (that legacy shape has no repoKey-keyed
// equivalent and is out of scope for this repoKey-only health check).
function ingestProjectLockPath(home, repoKey) {
  return path.join(devswarmRoot(home), 'locks', 'ingest-project-' + String(repoKey) + '.lock');
}

function isAliveDefault(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// formatRelative(ts, now) -> compact relative age ("18m", "2h", "3d", "5s") or
// "—" when the signal is unknown/absent. Byte-for-byte copy of
// devswarm-parent-inbox.js's own helper (kept local — that hook's copy also
// drives its live-table "last" column, an unrelated concern this module has no
// business reaching into).
function formatRelative(ts, now) {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  let delta = now - ts;
  if (delta < 0) delta = 0;
  const s = Math.floor(delta / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

// buildStaleBanner(beatTs, now) -> the SAME visible daemon-liveness warning
// text devswarm-parent-inbox.js renders (byte-for-byte), so a child sees
// IDENTICAL wording to the Primary when its project's daemon looks stopped.
function buildStaleBanner(beatTs, now) {
  return (
    '⚠ DEVSWARM STALE DATA: ingest daemon last alive ' + formatRelative(beatTs, now)
    + ' ago — data may be stale (the daemon may have stopped or never started for '
    + 'this worktree). Run /anti-hall:doctor to check the DevSwarm ingest daemon.'
  );
}

// doctorRepairMod() — lazy, fail-open require of hooks/lib/doctor-repair.js's
// EXPORTED monitorFaultFor() (v0.66 "alive but ingesting nothing" detection —
// see that module's own comment for the field/threshold rationale). Reused
// rather than re-implemented here so the MONITOR_FAILURE_FAIL_THRESHOLD /
// MONITOR_OK_STALE_MS constants and the missing-fields=UNKNOWN rule live in
// exactly ONE place — this hot-path banner and doctor's repair verdict can
// never drift apart. Safe to require top-down: doctor-repair.js's own
// MODULE-LEVEL code only requires os/fs/path/child_process (every other
// cross-module require in it — devswarm-ingest.js, scripts/devswarm.js, etc,
// one of which itself requires THIS file — is lazy, inside function bodies,
// so no load-time cycle exists; see the coherence-gap note in daemonHealth
// below). Required LAZILY here too (mirrors doctor-repair.js's own
// ingestDaemonMod()/repokeyMod() pattern) so the two per-turn hot-path hooks
// that require THIS file pay nothing when the monitor-fault branch is never
// reached (win32 / repoKey-null / not-baseHealthy).
function doctorRepairMod() {
  try { return require(path.join(__dirname, '..', '..', 'hooks', 'lib', 'doctor-repair.js')); } catch (_) { return {}; }
}

// daemonHealth(home, repoKey, opts) -> { status, fresh, liveLock, monitorFault }
//   status: 'healthy'     — fresh heartbeat AND a live-pid lock holder, monitor OK
//           'failed'      — (v0.66) same liveness signals as 'healthy', but the
//                           daemon's `hivecontrol workspace monitor` spawn is
//                           FAILING past doctor-repair.js's monitorFaultFor()
//                           threshold — alive, but ingesting NOTHING. Deliberately
//                           NOT folded into 'stale': the liveness signals here are
//                           positively fine (fresh heartbeat, live-pid lock, same
//                           incarnation) — reporting 'stale' would contradict that
//                           and mislead the (accurate, very-recent) relative age in
//                           buildStaleBanner. A heartbeat missing the v0.66 monitor
//                           fields (pre-v0.66 daemon) is UNKNOWN, never 'failed'
//                           (fail-open — see monitorFaultFor's own LEGACY GUARD).
//           'stale'       — either base signal fails (incl. repoKey null/unresolved)
//           'unsupported' — win32 (D28); the daemon cannot run there at all
// Pure fs; fail-open throughout — any read/parse error degrades the SPECIFIC
// signal to false, never throws the whole call.
function daemonHealth(home, repoKey, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  if (platform === 'win32') return { status: 'unsupported', fresh: false, liveLock: false, monitorFault: null };

  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const F = (o.io && o.io.fs) || fs;
  const isAlive = (o.io && o.io.isAlive) || isAliveDefault;

  let fresh = false;
  let beatPid = null;
  if (repoKey) {
    try {
      const raw = F.readFileSync(ingestHeartbeatPath(home, repoKey), 'utf8');
      const beat = JSON.parse(raw);
      const ts = beat && Number.isFinite(beat.ts) ? beat.ts : null;
      beatPid = beat && Number.isFinite(beat.pid) ? beat.pid : null;
      fresh = ts !== null && (now - ts) <= HEARTBEAT_STALE_MS;
    } catch (_) { fresh = false; } // missing/unreadable/malformed = NOT-fresh (D25)
  }

  let liveLock = false;
  let lockPid = null;
  if (repoKey) {
    try {
      const raw = F.readFileSync(ingestProjectLockPath(home, repoKey), 'utf8');
      const holder = JSON.parse(raw);
      lockPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
      liveLock = lockPid !== null && isAlive(lockPid);
    } catch (_) { liveLock = false; } // missing/unreadable/malformed = NOT-live (D25)
  }

  // SAME-INCARNATION GUARD: fresh + liveLock alone can still mix TWO different
  // daemon incarnations — e.g. daemon A's heartbeat (still fresh) plus daemon
  // B's lock (live pid, B just started and hasn't written its own first
  // heartbeat yet). Combining A's freshness with B's liveness reports
  // "healthy" for a process (B) whose own health was never actually checked;
  // once A's heartbeat goes stale, the steal path in acquireIngestLock
  // (devswarm-ingest.js) refuses to reclaim because ITS pid check (against the
  // CURRENT holder, B) never matches A's leftover heartbeat pid either — so a
  // stopped/wedged B can be reported healthy (or refused-for-reclaim)
  // indefinitely. Requiring the heartbeat's own claimed pid to equal the live
  // lock holder's pid binds both signals to the SAME incarnation before
  // either can count toward 'healthy'. Writers already agree on this: both
  // devswarm-ingest.js's writeIngestHeartbeat and its lock record stamp
  // `pid: process.pid` from the same process, so a genuinely healthy daemon's
  // own heartbeat and lock always carry matching pids already.
  const sameIncarnation = beatPid !== null && lockPid !== null && beatPid === lockPid;
  const baseHealthy = fresh && liveLock && sameIncarnation;

  // v0.66 MONITOR-OUTCOME FAULT: checked ONLY when baseHealthy — an
  // unhealthy/mismatched-incarnation heartbeat's monitor fields are not
  // trustworthy anyway (same gating doctor-repair.js's own runRepairs uses:
  // `if (alive) { monitorFault = monitorFaultFor(...) }`). monitorFaultFor is
  // itself fail-open (never throws, null on any doubt including a legacy
  // heartbeat missing the v0.66 fields), so this try/catch is belt-and-
  // suspenders against a missing/broken doctor-repair.js module.
  let monitorFault = null;
  if (baseHealthy && repoKey) {
    try {
      const dr = doctorRepairMod();
      if (typeof dr.monitorFaultFor === 'function') {
        monitorFault = dr.monitorFaultFor(home, repoKey, now, o.io) || null;
      }
    } catch (_) { monitorFault = null; }
  }

  const status = monitorFault ? 'failed' : (baseHealthy ? 'healthy' : 'stale');
  return { status, fresh, liveLock, monitorFault };
}

// buildMonitorFaultBanner(fault) -> a short, ONE-LINE, actionable banner for
// the v0.66 monitor-outcome fault (daemonHealth() status:'failed') — the
// daemon is alive but its `hivecontrol workspace monitor` calls are failing,
// so it is ingesting NOTHING. Deliberately terser than doctor-repair.js's own
// monitorFaultReason() (that one is a one-shot CLI report; this is injected
// into every session turn under the shared ~10k-char hook-injection cap).
// `fault` is the object returned by doctor-repair.js's monitorFaultFor()
// (daemonHealth()'s own `.monitorFault` field) — never throws on a null/
// malformed fault, matching buildStaleBanner's own fail-open contract.
function buildMonitorFaultBanner(fault) {
  const f = fault || {};
  const consecutive = Number.isFinite(f.consecutive) ? f.consecutive : '?';
  return (
    '⚠ DEVSWARM INGEST FAILING: daemon is alive but `hivecontrol workspace monitor` has failed '
    + consecutive + 'x in a row' + (f.code ? ' (' + f.code + ')' : '')
    + ' — ingesting NOTHING. Run /anti-hall:doctor to repair the ingest daemon.'
  );
}

module.exports = {
  HEARTBEAT_STALE_MS,
  ingestHeartbeatPath,
  ingestProjectLockPath,
  daemonHealth,
  buildStaleBanner,
  buildMonitorFaultBanner,
};
