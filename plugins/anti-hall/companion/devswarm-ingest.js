#!/usr/bin/env node
'use strict';
// anti-hall :: devswarm-ingest — ONE supervised Node daemon that wraps
// `hivecontrol workspace monitor` and folds the messages it drains into the
// store (companion/lib/devswarm-store.js). Replaces the ad-hoc shell inbox
// daemon; restart-on-crash friendly (a launchd/systemd unit re-execs it).
//
// SINGLE-NATIVE-CONSUMER INVARIANT (PLAN.md Phase 2, Fable P1-5). Two concurrent
// `monitor` consumers SPLIT the destructive native queue between them — each
// call drains what the other never saw, silently losing messages. So this daemon
// takes an O_EXCL lock and REFUSES to start when another monitor consumer already
// holds it. The lock is the mechanical enforcement of the invariant, not just a
// doc note. `hivecontrol workspace monitor` is the ONE allowed native consumer
// while this runs (command-guard blocks interactive `monitor`/`read-messages`).
//
// IDEMPOTENT via a per-message dedupe hash: the native queue buffers until the
// next monitor call, and a crash-then-restart can re-observe an in-flight batch,
// so every message is content-hashed and appendMessage OR-IGNOREs a duplicate —
// safe replay / catch-up.
//
// LAYERING: this is a WRITE-side producer only. Hooks never touch it; they read
// the derived summary.json the store writes. deriveSummary is re-run after each
// ingested batch so the projection stays fresh.
//
// Pure Node built-ins. The monitor child spawn + the loop clock are injectable so
// the unit tests exercise ingest/lock/normalize WITHOUT spawning real hivecontrol.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const store = require('./lib/devswarm-store.js');
const { devswarmRoot } = require('./lib/liveness.js');
// The installer OWNS per-worktree identity (worktreeHash / labelForWorktree / …). The
// daemon reuses those exact helpers so its lock + workspaceId agree byte-for-byte
// with what install-devswarm-ingest.js baked into the unit. Requiring the installer
// does NOT run it (main() is guarded by require.main===module) and introduces no
// cycle (the installer never requires this file).
const installIngest = require('./install-devswarm-ingest.js');
// v0.57 mesh (PLAN-v0.57-mesh.md D1/D8/D9/D21): the shared per-project store key —
// the daemon's lock/heartbeat naming AND the physical store it drains INTO are both
// re-keyed to repoKey, while the SELF-REGISTERED workspaceId stays worktree-hash
// based (D19 — liveness surfaces are never re-keyed).
// D27: guarded, NOT a bare require — this module is itself required TOP-LEVEL
// by hooks (devswarm-parent-inbox.js), whose fail-open guarantee only wraps
// their own main() call. `repokey` is null on failure; every call site below
// already fails open (try/catch or a null check) when it is.
let repokey = null;
try { repokey = require('./lib/devswarm-repokey.js'); } catch (_) { repokey = null; }

// B1 self-heal hardening: structured logging via the shared C0 logger when
// present, falling back to a console.error-only no-frills shim so this daemon
// never depends on that module existing (tests exercise both cases).
let alog;
try { alog = require('./lib/anti-hall-log.js'); } catch (_) {
  alog = {
    logError: function () { try { console.error.apply(console, arguments); } catch (_e) {} },
    logEvent: function () {},
  };
}

const INGEST_LOCK_STALE_MS = 15 * 60 * 1000; // a monitor consumer is long-lived; used to judge an UNKNOWN holder's liveness — a KNOWN-dead holder is reclaimed immediately regardless of this window (see acquireIngestLock's P1-B steal rule)
const DEFAULT_MONITOR_INTERVAL_SEC = 3;      // hivecontrol monitor default poll
const DEFAULT_RESTART_BACKOFF_MS = 2000;     // gap before re-spawning after a monitor exit/crash
// DEFAULT_MONITOR_TIMEOUT_SEC — the bounded `-t` timeout given to EVERY `hivecontrol
// workspace monitor` call. Without a timeout, monitor long-polls (BLOCKS) until a
// message arrives; on a live-but-QUIET workspace that parks runIngestLoop's iteration
// inside run() indefinitely, so the per-iteration heartbeat write (see
// writeIngestHeartbeat below) only fires per-MESSAGE, not per-interval, and goes
// stale -> the freshness banner + doctor's daemon-running check false-report a live
// daemon as down. Bounding the call guarantees the loop iterates (and heartbeats) at
// least this often even with ZERO messages; a timed-out/empty monitor call is NOT an
// error (see defaultMonitorRun) and no message is lost — hivecontrol's native queue
// buffers until the next poll and ingestPayload is idempotent by hash.
const DEFAULT_MONITOR_TIMEOUT_SEC = 30;

// ingestLockPath(home, worktree) — PER-PROJECT lock (v0.57 mesh, D1/D9/Phase5): so
// a 2nd daemon for a DIFFERENT project does not collide on one global O_EXCL lock
// and refuse-and-exit, while every worktree of the SAME project (linked worktrees
// share a git-common-dir) contends for the SAME lock — exactly the "ONE daemon per
// project" invariant. When `worktree` resolves to a real git repo the lock is
// `locks/ingest-project-<repoKey>.lock`; when repoKey cannot be derived (a fake/
// non-existent worktree path — the direct unit-test posture) it falls BACK to the
// legacy per-worktree shape `locks/ingest-<hash>.lock` (fail-open, never throws);
// with no worktree at all it falls back to the legacy global `locks/ingest.lock`.
function ingestLockPath(home, worktree) {
  const dir = path.join(devswarmRoot(home), 'locks');
  if (worktree) {
    try {
      const repoKey = repokey.repoKeyForWorktree(worktree);
      if (repoKey) return path.join(dir, 'ingest-project-' + repoKey + '.lock');
    } catch (_) {}
    try { return path.join(dir, 'ingest-' + installIngest.worktreeHash(worktree) + '.lock'); } catch (_) {}
  }
  return path.join(dir, 'ingest.lock');
}

// ingestHeartbeatPath(home, hash) — the per-worktree daemon liveness file the ingest
// loop rewrites EVERY sweep (even a quiet cycle with 0 inserts). A follow-up rewires
// the freshness banner + doctor's daemon-RUNNING check to key off this instead of
// summary.json's generatedAt (which only advances on inserted>0, so a live-but-quiet
// daemon false-reads as stale).
function ingestHeartbeatPath(home, hash) {
  return path.join(devswarmRoot(home), 'heartbeats', 'ingest-' + String(hash) + '.json');
}

function isAliveDefault(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// defaultKillProcess(pid, sig) — the only place in this file that sends a
// non-probe signal. process.kill maps SIGKILL to TerminateProcess on win32
// (no guard needed there); the caller always wraps this in try/catch (ESRCH if
// the pid already exited between the isAlive() probe and this call, EPERM if
// disallowed).
function defaultKillProcess(pid, sig) {
  process.kill(pid, sig);
  return true;
}

// defaultProcessStartTimeMs(pid) -> epoch ms the OS reports pid as having
// started, or null when it cannot be determined (no such pid, platform probe
// failed/unavailable). PID-REUSE GUARD (see isHolderHeartbeatStale below): a
// dead daemon's leaked lock/heartbeat freezes with the OLD pid baked into both
// records; once the OS later hands that SAME pid number to an unrelated live
// process (a shell, editor, another Claude session), `isAlive(pid)` reports
// true and the frozen records still "match" by content alone — content can
// never distinguish "still the same process, just wedged" from "a totally
// different process that coincidentally got the recycled pid". Only the OS
// itself can answer that, via the process's actual start time. Best-effort by
// design: an unresolvable start time must NEVER be treated as proof of
// identity (see the caller's fail-toward-never-kill handling of null).
function defaultProcessStartTimeMs(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      // Pure fs, no spawn: /proc/<pid>/stat field 22 (starttime, in clock
      // ticks since boot) + /proc/stat's `btime` (boot time, epoch seconds).
      // `comm` (field 2) is parenthesized and may itself contain spaces/
      // parens, so split on the LAST ')' rather than naively splitting on
      // spaces (mirrors the same defensive parse other /proc readers use).
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const idx = stat.lastIndexOf(')');
      if (idx === -1) return null;
      const rest = stat.slice(idx + 2).trim().split(/\s+/);
      // rest[0] is field 3 (state); starttime is field 22 overall -> index 19
      // in this 0-based `rest` array (22 - 3 = 19).
      const ticks = Number(rest[19]);
      const statRaw = fs.readFileSync('/proc/stat', 'utf8');
      const btimeLine = statRaw.split('\n').find((l) => l.startsWith('btime '));
      const btime = btimeLine ? Number(btimeLine.trim().split(/\s+/)[1]) : NaN;
      if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
      const USER_HZ = 100; // near-universal on modern Linux; no sysconf in pure Node — best-effort
      const ms = (btime * 1000) + Math.round((ticks / USER_HZ) * 1000);
      return Number.isFinite(ms) ? ms : null;
    }
    if (process.platform === 'darwin') {
      const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
      if (r.error || r.status !== 0) return null;
      const out = String(r.stdout || '').trim();
      if (!out) return null;
      const t = Date.parse(out);
      return Number.isFinite(t) ? t : null;
    }
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '(Get-Process -Id ' + Number(pid) + ' -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o")',
      ], { encoding: 'utf8', timeout: 5000 });
      if (r.error || r.status !== 0) return null;
      const out = String(r.stdout || '').trim();
      if (!out) return null;
      const t = Date.parse(out);
      return Number.isFinite(t) ? t : null;
    }
  } catch (_) { return null; }
  return null; // unknown platform — cannot resolve, fail toward never-kill
}

// PID_REUSE_TOLERANCE_MS — slack absorbed before an OS-reported start time is
// allowed to CONTRADICT a lock record's own timestamp. `ps -o lstart=` has
// 1-second resolution and truncates DOWN (so a genuine holder's reported start
// can never drift LATER than reality); this margin covers that rounding plus
// small clock jitter. It only ever makes the "this pid was RECYCLED, it is not
// our holder" verdict HARDER to reach — never easier.
//
// Both `startedAt` (read NOW, via ps/proc) and `ts` (recorded PREVIOUSLY, when
// the lock was written) are wall-clock epochs read at two different moments —
// a backward-then-forward system clock step (NTP correction, VM pause/resume)
// in between can make a genuinely still-running holder's `startedAt` read as
// LATER than `ts` by more than a couple of seconds, which would otherwise
// misclassify it 'reused' and authorize removing its still-live lock. This
// tolerance is widened (was 2s) to also absorb the common cases of that class
// — a typical slewed NTP correction, or a guest-tool-corrected VM pause/resume
// — without blurring into INGEST_LOCK_STALE_MS's unrelated 15-minute window.
// This is a bounded mitigation, not a complete fix: an UNBOUNDED manual clock
// change (or a misconfigured NTP daemon with step-panic disabled) can still
// exceed it. A fully rigorous fix needs a monotonic anchor recorded IN the
// lock file at write time (comparable across processes on the same boot, but
// not persisted today) — a lock-schema change, out of scope here.
const PID_REUSE_TOLERANCE_MS = 60000;

// defaultIsZombieProcess(pid) -> true ONLY when the OS positively reports the
// process as defunct/zombie (state Z). WHY THIS EXISTS: `process.kill(pid, 0)`
// — the whole basis of isAliveDefault — succeeds for a ZOMBIE (a process that
// has exited but whose parent has not yet reaped it), so a holder that died
// under a parent that never wait()s reads as "alive" forever and blocks every
// restart of this daemon permanently. A confirmed Z is dead: it will never run
// code again and can never release its own lock.
//
// FAIL TOWARD NEVER-RECLAIMING: any inconclusive read (no /proc entry, ps
// missing/failed/empty, unknown platform) returns FALSE, so an unreadable
// process state can never be mistaken for proof of death. win32 is skipped
// outright — there is no Z state in the Windows process model, and the ingest
// daemon is a documented no-op there (see install-devswarm-ingest.js's
// windowsNoop), so probing would only add flap. Never sends a signal.
function defaultIsZombieProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (process.platform === 'win32') return false;
  try {
    if (process.platform === 'linux') {
      // /proc/<pid>/stat field 3 is the state character. `comm` (field 2) is
      // parenthesized and may itself contain spaces/parens, so split on the
      // LAST ')' — the same defensive parse defaultProcessStartTimeMs uses.
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const idx = stat.lastIndexOf(')');
      if (idx === -1) return false;
      const rest = stat.slice(idx + 2).trim().split(/\s+/);
      return rest[0] === 'Z';
    }
    if (process.platform === 'darwin') {
      // BSD ps `state` column: the first character is the run state; a zombie
      // is reported as `Z` (see ps(1) STATE). A non-zero exit (no such pid)
      // or empty output is inconclusive -> false.
      const r = spawnSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
      if (r.error || r.status !== 0) return false;
      return String(r.stdout || '').trim().charAt(0) === 'Z';
    }
  } catch (_) { return false; }
  return false; // unknown platform -> cannot determine -> never reclaim
}

// safeProcessStartTimeMs(pid, io) -> number | null. Never throws; io.startTimeOf
// is the test-injection seam (same convention as io.fs / io.isAlive / io.now).
function safeProcessStartTimeMs(pid, io) {
  const f = (io && io.startTimeOf) || defaultProcessStartTimeMs;
  try {
    const v = f(pid);
    return Number.isFinite(v) ? v : null;
  } catch (_) { return null; }
}

// isZombieHolder(pid, io) -> bool. Never throws; io.isZombie is the injection seam.
function isZombieHolder(pid, io) {
  const probe = (io && io.isZombie) || defaultIsZombieProcess;
  try { return !!probe(pid); } catch (_) { return false; }
}

// classifyLockHolder(holder, nowMs, io) -> { state, pid, ts, startedAt? }. The ONE
// place that decides what a lock record's recorded holder actually IS, shared by
// acquireIngestLock, probeLegacyHolders and sweepOrphanedIngestLocks so all three
// apply an identical (and identically conservative) rule. `holder` is a
// readLockHolder() result ({pid, ts}); pid===null means the record was torn/
// unparseable and only its mtime can speak for it.
//
// States, and what each is allowed to authorize:
//   'dead'              pid known, OS says no such process    -> reclaim + REMOVE the lock
//   'reused'            pid alive, its OS start time POSTDATES the lock's own ts
//                       (a process born after the lock was written cannot be the
//                       process that wrote it), AND the lock ts is itself past the
//                       stale window -> the real (dead) holder can no longer be
//                       refreshing it, so nothing is lost by treating it as gone
//                                                             -> reclaim + REMOVE the lock
//   'reused-fresh'      same start-time-postdates-ts evidence as 'reused', but the
//                       lock ts is still within the stale window: a live daemon
//                       refreshes its own lock's ts every loop iteration
//                       (release.heartbeat), so a GENUINE holder's ts is always
//                       fresh here and the postdate reading can therefore only be
//                       an artifact (clock step/NTP slew/VM pause exceeding
//                       PID_REUSE_TOLERANCE_MS's bounded margin — see that
//                       constant's own comment) — NOT a state a live process can
//                       be told apart from -> NEVER touch, refuse/block (same as
//                       'live'); requiring staleness too costs nothing against a
//                       truly recycled pid, since nothing remains to refresh that
//                       lock and it is therefore always stale within
//                       INGEST_LOCK_STALE_MS
//   'zombie'            pid alive per kill(pid,0) but confirmed defunct (state Z)
//                                                             -> reclaim + REMOVE the lock
//   'live'              pid alive AND its start time is CONSISTENT with the lock
//                       (or unresolvable while the lock is still fresh)
//                                                             -> NEVER touch, refuse/block
//   'unconfirmed-stale' pid alive, identity UNRESOLVABLE, and the lock ts is past
//                       the stale window -> not provably our holder, so it does
//                       not BLOCK a legacy probe, but nothing is removed and no
//                       signal is ever sent
//   'torn-fresh'        unparseable record, fresh mtime: presumed a live holder
//                       mid-write                             -> NEVER touch
//   'torn-stale'        unparseable record, mtime past the stale window: presumed
//                       abandoned mid-write                   -> sweepable
//   'none'              nothing there at all
//
// NEVER-KILL / NEVER-DELETE-ON-DOUBT is the invariant: every removal-authorizing
// state requires POSITIVE OS confirmation. An isAlive probe that THROWS is read as
// alive (the safe direction). A start time that is unresolvable — or implausible
// (later than `nowMs`, which is what an injected/skewed clock looks like) — yields
// NO reuse verdict at all.
function classifyLockHolder(holder, nowMs, io) {
  if (!holder) return { state: 'none', pid: null, ts: null };
  const isAlive = (io && io.isAlive) || isAliveDefault;
  const ts = Number.isFinite(holder.ts) ? holder.ts : null;
  const pid = Number.isFinite(holder.pid) ? holder.pid : null;
  if (pid === null) {
    if (ts !== null && (nowMs - ts) <= INGEST_LOCK_STALE_MS) return { state: 'torn-fresh', pid: null, ts };
    return { state: 'torn-stale', pid: null, ts };
  }
  let alive;
  try { alive = !!isAlive(pid); } catch (_) { alive = true; } // a broken probe must never read as "dead"
  if (!alive) return { state: 'dead', pid, ts };
  const startedAt = safeProcessStartTimeMs(pid, io);
  // A start time LATER than our own clock is not credible evidence about
  // anything (mismatched/injected clocks, a skewed OS reading) — discard it
  // rather than let it authorize a removal.
  const startPlausible = Number.isFinite(startedAt) && startedAt <= nowMs;
  if (startPlausible && ts !== null && startedAt > (ts + PID_REUSE_TOLERANCE_MS)) {
    // Require the LOCK to also be stale before this authorizes removal — a
    // live holder refreshes its own lock's ts every iteration, so a genuine
    // holder's ts is never both fresh AND postdated by its own start time;
    // only a fresh-but-postdated reading is ambiguous (clock skew) and must
    // never authorize a removal. See the 'reused' / 'reused-fresh' states above.
    if ((nowMs - ts) > INGEST_LOCK_STALE_MS) return { state: 'reused', pid, ts, startedAt };
    return { state: 'reused-fresh', pid, ts, startedAt };
  }
  if (isZombieHolder(pid, io)) return { state: 'zombie', pid, ts };
  if (startPlausible) return { state: 'live', pid, ts, startedAt }; // identity CONSISTENT with the lock -> a real holder
  if (ts !== null && (nowMs - ts) > INGEST_LOCK_STALE_MS) return { state: 'unconfirmed-stale', pid, ts };
  return { state: 'live', pid, ts };
}

// RECLAIMABLE_HOLDER_STATES — the ONLY states that authorize unlinking someone
// else's lock file. Each requires positive OS confirmation that the recorded
// holder is not a running consumer (see classifyLockHolder). 'reused-fresh' is
// DELIBERATELY excluded — it is the same postdated-start-time evidence as
// 'reused' but without the lock also being stale, which a live, heartbeat-
// refreshing holder can never simultaneously be; keeping it out of this list
// is what makes it refuse/never-touch instead of reclaim.
const RECLAIMABLE_HOLDER_STATES = ['dead', 'reused', 'zombie'];
function isReclaimableHolderState(state) { return RECLAIMABLE_HOLDER_STATES.indexOf(state) !== -1; }

// NON_BLOCKING_HOLDER_STATES / isBlockingHolderState — the companion rule for
// the OTHER thing a verdict decides: whether a recorded holder still stops a
// second monitor consumer from starting (probeLegacyHolders). Expressed
// DELIBERATELY as a deny-list — the reclaimable states (positively proven not a
// running consumer) plus the two records that name no live process at all
// ('none' = nothing there, 'torn-stale' = a mid-write record abandoned past the
// stale window). EVERY other state blocks, including any state added later.
//
// THAT POLARITY IS THE POINT. The previous form was an allow-list of blockers
// ('live' || 'torn-fresh' || 'unconfirmed-stale'), which silently turned each
// NEW never-reclaimable state into a NON-blocker that fell through both
// branches: 'reused-fresh' would neither block nor be reaped, so a live legacy
// holder misread as pid-reuse (clock step/NTP slew/VM pause) would let a SECOND
// `hivecontrol workspace monitor` start against the same DESTRUCTIVE native
// queue — the exact single-consumer split this lock exists to prevent, arrived
// at by a route that removes nothing and so trips no removal guard. Default-
// block makes that class of mistake impossible for a future call site.
const NON_BLOCKING_HOLDER_STATES = RECLAIMABLE_HOLDER_STATES.concat(['none', 'torn-stale']);
function isBlockingHolderState(state) { return NON_BLOCKING_HOLDER_STATES.indexOf(state) === -1; }

// resolveLockHbHash(worktree) -> the SAME hash the ingest daemon's OWN
// liveness heartbeat file is keyed by (repoKey when resolvable, else the
// legacy worktreeHash) — mirrors runIngestLoop's own `hbHash = repoKey ||
// safeWorktreeHash(worktree)` (below). Since the ingest lock is itself
// per-project (ingestLockPath), the CURRENT holder of a given lock is, by
// construction, the one daemon that would be writing heartbeats/ingest-
// <hash>.json for that same hash — so this is a safe way to find the
// wedged-candidate's own heartbeat file without knowing its pid's identity
// any more precisely than "whoever holds this lock". Never throws.
function resolveLockHbHash(worktree) {
  return safeRepoKey(worktree) || safeWorktreeHash(worktree);
}

// isHolderHeartbeatStale(home, worktree, nowMs, F, io, holderPid) -> bool. H2
// heartbeat-aware steal (see acquireIngestLock's STEAL RULE comment below):
// reads the would-be-stolen LIVE holder's own daemon heartbeat (heartbeats/
// ingest-<hash>.json, rewritten every sweep by writeIngestHeartbeat) and
// reports whether it has gone stale beyond INGEST_LOCK_STALE_MS — i.e. the
// daemon is wedged (its event loop can no longer run even the per-iteration
// heartbeat write, e.g. blocked inside a hung child spawnSync — H3), not
// merely busy.
//
// PID-IDENTITY GUARD (two independent checks, both required before "stale"
// can mean anything, since the SIGKILL this gates is irreversible):
//   1. The heartbeat file is keyed by HASH, not by pid — it can carry a
//      DIFFERENT pid than `holderPid` (the CURRENT lock holder we are
//      considering killing): a leftover record from a prior daemon instance
//      that used the same hash, or any other mismatch. A heartbeat is only
//      evidence about the pid it ITSELF claims to be; judging a different
//      holderPid's liveness from it would be a category error. Concrete
//      repro this closes: a stale heartbeat recorded {pid:111111} plus a
//      live, healthy lock holder {pid:424242} — without this check the
//      staleness of the UNRELATED 111111 heartbeat wrongly condemned the
//      live 424242 holder.
//   2. Even when the pid matches, a stale heartbeat + a currently-"alive"
//      holderPid is ALSO exactly what PID REUSE looks like: the original
//      daemon died, leaked its lock+heartbeat (both frozen with its old pid),
//      and the OS later handed that SAME pid number to an unrelated live
//      process (a shell, editor, another Claude session). Positively confirm
//      the CURRENTLY-alive process at holderPid could actually BE the one
//      that wrote this heartbeat: its OS-reported start time must be AT OR
//      BEFORE the heartbeat's own last-good `ts` — a process that started
//      AFTER this heartbeat was last written cannot possibly be the process
//      that wrote it (see defaultProcessStartTimeMs above).
//
// FAIL TOWARD NEVER-KILL: any inconclusive signal (no worktree/hash to
// derive, no heartbeat file yet, malformed JSON, missing ts, pid mismatch,
// unresolvable start time) returns false. This mirrors the existing STEAL
// RULE's own asymmetry between a KNOWN-dead pid (reclaim immediately) and an
// UNKNOWN one (needs both stale AND not-alive). `io.heartbeatStale`, when a
// function, is an explicit test override (used to exercise the steal/refuse
// branches without needing a real heartbeat file on disk in every test) —
// it is trusted as-is and skips the pid/start-time checks below (a test
// asserting its own override's contract is expected to encode them itself).
function isHolderHeartbeatStale(home, worktree, nowMs, F, io, holderPid) {
  const override = io && typeof io.heartbeatStale === 'function' ? io.heartbeatStale : null;
  if (override) {
    try { return !!override(home, worktree, nowMs, holderPid); } catch (_) { return false; }
  }
  const hash = resolveLockHbHash(worktree);
  if (!hash) return false;
  try {
    const raw = F.readFileSync(ingestHeartbeatPath(home, hash), 'utf8');
    const beat = JSON.parse(raw);
    const ts = beat && Number.isFinite(beat.ts) ? beat.ts : null;
    if (ts === null) return false; // can't prove staleness -> never kill
    const beatPid = beat && Number.isFinite(beat.pid) ? beat.pid : null;
    if (holderPid != null && (beatPid === null || beatPid !== holderPid)) return false; // wrong pid's heartbeat -> never kill
    if ((nowMs - ts) <= INGEST_LOCK_STALE_MS) return false; // not stale
    const startTimeOf = (io && io.startTimeOf) || defaultProcessStartTimeMs;
    let startedAt = null;
    try { startedAt = startTimeOf(holderPid); } catch (_) { startedAt = null; }
    if (!Number.isFinite(startedAt)) return false; // can't confirm identity -> never kill
    if (startedAt > ts) return false; // this pid postdates the heartbeat -> likely a reused pid, not the same process -> never kill
    return true;
  } catch (_) {
    return false; // missing/unreadable heartbeat -> never kill (fail toward safety)
  }
}

// acquireIngestLock(home, io) -> release() | null. null => another monitor
// consumer holds the lock; the daemon MUST refuse to start (single-consumer
// invariant). The returned release() carries a `.heartbeat()` the live daemon
// calls each loop to REFRESH its own lock timestamp, so a healthy long-lived
// consumer is never seen as stale (and thus never stolen).
//
// STEAL RULE (data-loss guard): a KNOWN-LIVE holder is NEVER stolen merely for
// looking stale by lock timestamp — stealing from a live `hivecontrol workspace
// monitor` consumer would split the destructive native queue between two
// daemons and silently lose messages. A holder with a KNOWN pid confirmed DEAD
// is reclaimed IMMEDIATELY (P1-B) — a dead process can never come back, so
// there is nothing to gain by waiting out the staleness window. An UNKNOWN
// holder (an unparseable/torn lock record with no pid to check) still needs
// BOTH stale AND not-alive before reclaim, since its liveness can only be
// inferred from mtime, never confirmed. This covers both the earlier
// "stale-steals-a-live-daemon" bug (never steal a live or unconfirmed holder)
// and the "leaked lock stranded ingestion for 15 minutes" bug (a confirmed-dead
// holder no longer waits out the window).
//
// H2 heartbeat-aware steal (self-heal hardening): a KNOWN-LIVE holder is a
// SEPARATE case from "confirmed dead" — it is either genuinely busy or WEDGED
// (blocked inside a hung child call, e.g. spawnSync — H3 — with an event loop
// that can no longer run its own per-sweep heartbeat write OR respond to
// SIGTERM). isHolderHeartbeatStale distinguishes the two using the holder's
// OWN daemon liveness heartbeat (independent of the lock's own timestamp,
// which release.heartbeat can refresh even while the loop body is about to
// wedge): a live pid whose heartbeat is positively confirmed stale is
// SIGKILLed (SIGTERM is undeliverable to a wedged loop) and the lock reclaimed;
// a live pid with a fresh heartbeat, or one whose heartbeat cannot be read at
// all, is left alone exactly as before this fix (fail-open toward never
// killing).
function acquireIngestLock(home, io, worktree) {
  const F = (io && io.fs) || fs;
  const isAlive = (io && io.isAlive) || isAliveDefault;
  const now = (io && io.now) || Date.now;
  const p = ingestLockPath(home, worktree);
  try { F.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
  for (let attempt = 0; attempt < 2; attempt++) {
    const ts = now();
    const token = process.pid + ':' + ts + ':' + Math.random().toString(36).slice(2);
    try {
      const fd = F.openSync(p, 'wx');
      try { F.writeSync(fd, JSON.stringify({ pid: process.pid, ts, token })); } finally { F.closeSync(fd); }
      const release = function release() {
        try { const cur = JSON.parse(F.readFileSync(p, 'utf8')); if (cur && cur.token === token) F.unlinkSync(p); } catch (_) {}
      };
      // heartbeat(atMs?) — refresh OUR lock's ts (atomic tmp+rename) so a healthy
      // long-lived daemon stays fresh and is never mistaken for a stale holder.
      // No-op (and never clobbers) if the lock was reclaimed by someone else
      // (token mismatch) or is gone. Returns true iff we refreshed our own lock.
      release.heartbeat = function heartbeat(atMs) {
        try {
          const cur = JSON.parse(F.readFileSync(p, 'utf8'));
          if (cur && cur.token === token) {
            const nts = Number.isFinite(atMs) ? atMs : now();
            const tmp = p + '.hb.' + process.pid;
            F.writeFileSync(tmp, JSON.stringify({ pid: cur.pid, ts: nts, token }));
            F.renameSync(tmp, p);
            return true;
          }
        } catch (_) {}
        return false;
      };
      return release;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
      let holder = null;
      try { holder = JSON.parse(F.readFileSync(p, 'utf8')); } catch (_) {}
      const holderPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
      let holderTs = holder && Number.isFinite(holder.ts) ? holder.ts : null;
      if (holderTs === null) {
        // TORN-READ GUARD: a live holder is briefly a 0-byte file between openSync('wx')
        // and writeSync. A concurrent reader that catches it empty/unparseable must NOT
        // treat it as absent — fall back to the file's MTIME for liveness. A FRESH mtime =
        // live holder mid-write -> back off (never steal); only an OLD mtime (or a stat
        // failure) reads as a dead holder we may reclaim. Mirrors devswarm-store acquireOnce.
        try { holderTs = F.statSync(p).mtimeMs; } catch (_) { holderTs = null; }
      }
      const alive = holderPid !== null && isAlive(holderPid); // the OS reports SOMETHING live at that pid
      // v0.65 ORPHAN-RECLAIM: "the OS says pid N is alive" is NOT the same as
      // "pid N is still OUR holder, and it is still a running consumer".
      //   * PID REUSE — the daemon died, leaked this lock (frozen with its old
      //     pid), and the OS later handed that pid NUMBER to an unrelated live
      //     process. Proven by the OS-reported start time postdating the lock's
      //     own ts. NO SIGNAL IS EVER SENT: the real holder is already gone and
      //     the unrelated live process is none of our business — only the
      //     orphaned FILE is removed.
      //   * ZOMBIE — kill(pid, 0) succeeds for a defunct (state Z) process, so a
      //     holder that exited under a parent that never reaped it used to block
      //     every restart forever. A confirmed Z can never run code again.
      // Both verdicts are CONFIRMED-ONLY (classifyLockHolder fails toward
      // never-reclaiming on any unresolvable/implausible reading), and both are
      // reclaim-WITHOUT-kill — the SIGKILL path below is untouched and still
      // requires the far stricter wedged-heartbeat proof.
      const holderClass = classifyLockHolder({ pid: holderPid, ts: holderTs }, now(), io);
      const reclaimReason = isReclaimableHolderState(holderClass.state) ? holderClass.state : null;
      // P1-B fix: a holder with a KNOWN pid that is confirmed DEAD can never come
      // back — reclaim it IMMEDIATELY, without waiting out the staleness window.
      // (Previously a lock leaked by a killed daemon stranded ingestion for up to
      // INGEST_LOCK_STALE_MS ~15min: Node cannot run a SIGTERM/SIGINT handler
      // while the event loop is blocked inside spawnSync, so a daemon killed mid-
      // spawn never got a chance to release its own lock — see runIngestLoop's
      // signal-handler comment. hardTimeoutMs bounds how long that block can last;
      // this dead-holder-immediate-reclaim is what actually closes the leaked-lock
      // window for every OTHER starter once the holder is confirmed gone.) An
      // UNKNOWN holder (unparseable/torn record, no pid to check) still needs BOTH
      // stale AND not-alive before reclaim — unchanged from before.
      const knownDead = reclaimReason !== null;
      const stale = holderTs === null || (now() - holderTs) > INGEST_LOCK_STALE_MS;
      if (knownDead || (stale && !alive)) {
        // A dead pid is the long-standing, already-documented case and stays
        // silent; the two NEW verdicts are surprising enough to be worth a
        // record (they are exactly what a KeepAlive refuse->exit->relaunch loop
        // looks like from the outside, so the log is how an operator sees the
        // loop actually break).
        if (reclaimReason === 'reused' || reclaimReason === 'zombie') {
          alog.logEvent('lock', 'reclaim-orphaned-ingest-lock', 'warn',
            'reclaimed the ingest lock from a recorded holder that is not a live consumer (' + reclaimReason + ') — no signal sent',
            { pid: holderPid, lockPath: p, reason: reclaimReason, holderTs });
        }
        try { F.unlinkSync(p); } catch (_) {}
        continue;
      }
      // H2 heartbeat-aware steal: a KNOWN-LIVE holder is still NEVER stolen
      // merely for looking stale by lock-ts (see this function's own STEAL RULE
      // header comment) — but "live" alone does not mean "healthy". If the
      // holder's OWN daemon heartbeat proves it is WEDGED (isHolderHeartbeatStale
      // above), SIGTERM cannot land on it (Node cannot preempt a blocked event
      // loop to dispatch a signal handler — see runIngestLoop's SIGNAL HANDLER
      // comment / H3's hardTimeoutMs), so SIGKILL is the only way to actually
      // free the lock. A FRESH heartbeat (busy-but-live) is NEVER touched —
      // isHolderHeartbeatStale's fail-toward-never-kill contract guarantees this
      // branch only fires on a POSITIVELY CONFIRMED stale heartbeat, never an
      // inconclusive read.
      //
      // REQUIRE `stale` (the LOCK's own timestamp, computed above) TOO — not
      // heartbeat-staleness alone. The daemon's own loop refreshes the lock ts
      // via release.heartbeat() EVERY iteration (runIngestLoop, before the
      // separate per-sweep writeIngestHeartbeat call), and writeIngestHeartbeat
      // is fully fail-open (any write error is swallowed). So a daemon that is
      // genuinely alive and looping — NOT wedged — can still show a stale
      // OWN-heartbeat file if only that separate heartbeat write path breaks
      // (e.g. its directory becomes unwritable) while the lock ts keeps
      // refreshing fine. Without also requiring the lock ts to be stale, that
      // failure alone would get a perfectly healthy consumer SIGKILLed and its
      // lock stolen — the exact single-consumer-split this lock exists to
      // prevent. A TRULY wedged daemon (blocked inside a hung child call) can't
      // run ANY part of its loop body, so both signals go stale together —
      // requiring both costs nothing in the genuine-wedge case this branch
      // exists to catch.
      if (alive && stale && isHolderHeartbeatStale(home, worktree, now(), F, io, holderPid)) {
        const killFn = (io && io.kill) || defaultKillProcess;
        let killErr = null;
        try { killFn(holderPid, 'SIGKILL'); } catch (e) { killErr = e; }
        const ctx = { pid: holderPid, lockPath: p, staleMs: INGEST_LOCK_STALE_MS };
        // Only reclaim when the kill actually landed (no error) OR the pid was
        // already gone (ESRCH — it exited between our isAlive() probe and this
        // call, so there is nothing left to protect). Any OTHER kill error
        // (EPERM, etc.) means we do NOT know the holder is actually dead — the
        // live process keeps running, so deleting its lock here would let a
        // contender acquire a SECOND, concurrent lock on top of a still-alive
        // holder (the exact single-consumer break this lock exists to
        // prevent). Refuse in that case rather than reclaim unconditionally.
        const killSucceededOrAlreadyGone = !killErr || killErr.code === 'ESRCH';
        if (killErr) {
          alog.logError('lock', 'steal-kill-wedged-holder', killErr, ctx);
        } else {
          alog.logEvent('lock', 'steal-kill-wedged-holder', 'warn',
            'reclaimed ingest lock from a live-but-wedged holder (stale own heartbeat) via SIGKILL', ctx);
        }
        if (!killSucceededOrAlreadyGone) return null; // kill did not confirm the holder is gone -> refuse, never reclaim
        try { F.unlinkSync(p); } catch (_) {}
        continue; // reclaim: loop back and re-attempt openSync('wx')
      }
      return null; // live-and-responsive holder, or a fresh/unknown lock -> refuse
    }
  }
  return null;
}

// messageHash(workspaceId, msg) — stable dedupe hash from the message's
// identifying fields, falling back to a canonical JSON of the whole object when a
// createdAt is absent. Two genuinely-distinct messages hash differently; a
// re-observed identical message hashes the same and is OR-IGNOREd on append.
function messageHash(workspaceId, msg) {
  const m = msg && typeof msg === 'object' ? msg : { value: msg };
  const keyed = [
    String(workspaceId),
    m.fromBranch != null ? String(m.fromBranch) : '',
    m.toBranch != null ? String(m.toBranch) : '',
    m.message != null ? String(m.message) : '',
    m.status != null ? String(m.status) : '',
    m.createdAt != null ? String(m.createdAt) : '',
  ].join('\x00');
  // When there is no createdAt to disambiguate, fold in a canonical JSON of the
  // full object so two same-text messages that DO differ elsewhere stay distinct.
  const suffix = (m.createdAt == null) ? ('\x00' + stableJson(m)) : '';
  return 'native:' + crypto.createHash('sha256').update(keyed + suffix).digest('hex');
}

// stableJson — key-sorted JSON so the hash is stable regardless of key order.
function stableJson(obj) {
  try {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(stableJson).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(obj[k])).join(',') + '}';
  } catch (_) { return '""'; }
}

// parseMonitorPayload(raw) -> { messages, recognized }. hivecontrol emits JSON
// by default (no --json flag). The exact monitor batch SHAPE is not pinned in
// the KB, so parse tolerantly: accept a JSON string OR an already-parsed
// value, and unwrap the plausible shapes — an array, `{ messages: [...] }`,
// `{ data: [...] }`, or a single message object. `recognized` is true whenever
// `raw` parsed cleanly into one of those known container shapes, EVEN WHEN
// that shape legitimately yields zero messages (an empty `[]`/`{messages:[]}`/
// `{data:[]}` is a normal "nothing arrived this window" result, not a loss —
// B1 POLARITY CARE: only unparseable JSON or a value matching none of the
// known shapes is `recognized: false`, which is what B1 loss-detection below
// keys off of). Anything unparseable -> `{ messages: [], recognized: false }`
// (fail-soft; a bad batch never crashes the loop).
function parseMonitorPayload(raw) {
  let val = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return { messages: [], recognized: true };
    try { val = JSON.parse(t); } catch (_) { return { messages: [], recognized: false }; }
  }
  if (Array.isArray(val)) return { messages: val.filter((x) => x && typeof x === 'object'), recognized: true };
  if (val && typeof val === 'object') {
    if (Array.isArray(val.messages)) return { messages: val.messages.filter((x) => x && typeof x === 'object'), recognized: true };
    if (Array.isArray(val.data)) return { messages: val.data.filter((x) => x && typeof x === 'object'), recognized: true };
    // A single message object (has any of the known message fields).
    if ('message' in val || 'fromBranch' in val || 'toBranch' in val) return { messages: [val], recognized: true };
  }
  return { messages: [], recognized: false };
}

// normalizeMonitorPayload(raw) -> message object[]. Thin wrapper over
// parseMonitorPayload kept for backward compatibility (exported, used
// directly by tests) — callers that need the `recognized` distinction (B1
// loss-detection) call parseMonitorPayload directly instead.
function normalizeMonitorPayload(raw) {
  return parseMonitorPayload(raw).messages;
}

// rawIsSubstantive(raw) -> bool. Mirrors normalizeMonitorPayload's own
// whitespace-empty short-circuit (`t === '' -> []`) so the two never disagree
// on what counts as "the ordinary empty poll window" (POLARITY CARE — must
// NOT flag a genuinely empty poll as a loss). A non-string `raw` (an
// already-parsed value, as some direct callers/tests pass) is substantive
// whenever it is not null/undefined — there is no "whitespace" concept for a
// parsed object, so any real value handed in is a real payload to account for.
function rawIsSubstantive(raw) {
  if (typeof raw === 'string') return raw.trim() !== '';
  return raw != null;
}

// ingestPayload(s, raw, opts) -> { total, inserted, duplicate, lossy }.
// Normalizes a monitor batch and appends each message to the store keyed by
// the ingesting workspace id, deduped by content hash. Re-ingesting the same
// batch inserts 0 (replay idempotence).
//
// B1 LOSS-EVENT DETECTION: `hivecontrol workspace monitor` is DESTRUCTIVE — it
// pops messages off the native queue as it prints them, so by the time `raw`
// reaches this function those messages are ALREADY GONE from the source of
// truth. If `raw` carries substantive bytes (not the ordinary empty/whitespace
// quiet-poll case) AND parseMonitorPayload could not even RECOGNIZE its shape
// — an output-shape change, stderr contamination, or a hardTimeoutMs kill
// mid-print (truncated JSON) — that batch's content is now UNRECOVERABLE: the
// next poll cannot re-observe it. `lossy` surfaces this to the caller
// (runIngestLoop), which owns home/logging/quarantine, so this function
// itself stays a pure transform with no fs/log side effects.
//
// POLARITY CARE (P1 fix): a raw payload that PARSES into one of the known
// container shapes but legitimately yields ZERO messages — `[]`,
// `{"messages":[]}`, `{"data":[]}` — is NOT lossy. hivecontrol's monitor
// verb "polls... then exits with them" (KB-devswarm-hivecontrol.md §4.1) and
// always emits JSON (no --json flag; JSON is the unconditional default per
// its own --help text) — a "nothing arrived this window" response is
// plausibly one of these well-formed empty containers, not raw silence. Only
// a payload that is UNPARSEABLE or matches NONE of the known shapes
// (`parseMonitorPayload(...).recognized === false`) is flagged lossy — that
// is the case that actually indicates lost/corrupted bytes, not a quiet poll.
function ingestPayload(s, raw, opts) {
  const o = opts || {};
  const workspaceId = String(o.workspaceId);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const parsed = parseMonitorPayload(raw);
  const messages = parsed.messages;
  let inserted = 0;
  let duplicate = 0;
  for (const m of messages) {
    const r = s.appendMessage({
      workspaceId,
      body: (m && m.message != null) ? String(m.message) : stableJson(m),
      hash: messageHash(workspaceId, m),
      ts: (m && Number.isFinite(Date.parse(m.createdAt))) ? Date.parse(m.createdAt) : now,
    });
    if (r && r.inserted) inserted++; else duplicate++;
  }
  const lossy = messages.length === 0 && rawIsSubstantive(raw) && !parsed.recognized;
  return { total: messages.length, inserted, duplicate, lossy };
}

// quarantineDir(home) — where a lossy batch's raw bytes are preserved (B1).
function quarantineDir(home) {
  return path.join(devswarmRoot(home), 'quarantine');
}

// QUARANTINE BOUNDS (P1 fix — was previously unbounded: no cap, no pruning, no
// rate-limit, no dedup). `QUARANTINE_MAX_FILES` bounds disk growth by
// REFUSING further writes once reached — it never prunes/deletes an existing
// file (the repo's no-delete invariant: an automated job must not remove
// forensic evidence a human may still need). `QUARANTINE_MAX_BODY_BYTES`
// bounds each individual file's size (a truncated diagnostic prefix is still
// enough to identify the shape that broke).
const QUARANTINE_MAX_FILES = 20;
const QUARANTINE_MAX_BODY_BYTES = 64 * 1024;

// quarantineCapacityReached(home, fsi) -> bool. Fails OPEN to `false` (never
// blocks a write over a readdir error) — refusing a write because we could
// not even confirm the directory is full would silently drop what might be
// the only surviving evidence of a real loss.
function quarantineCapacityReached(home, fsi) {
  const F = fsi || fs;
  try {
    const dir = quarantineDir(home);
    return F.readdirSync(dir).length >= QUARANTINE_MAX_FILES;
  } catch (_) {
    return false;
  }
}

// quarantineLossyMonitorBatch(home, raw, tag, fsi) -> path | null. Best-effort
// write of the UNRECOVERABLE raw bytes (see ingestPayload's `lossy` doc above)
// to a timestamped file so a human/tool can inspect what the native queue
// actually emitted. Fully fail-open on the WRITE itself (a quarantine-write
// failure — disk full, unwritable dir — must never crash the ingest loop);
// the caller logs the loss via the shared structured logger regardless of
// whether this write succeeds, so the loss is never silent even if this
// returns null. Returns null (writes nothing) once QUARANTINE_MAX_FILES is
// reached — existing files are left untouched, never pruned/deleted.
function quarantineLossyMonitorBatch(home, raw, tag, fsi) {
  const F = fsi || fs;
  try {
    const dir = quarantineDir(home);
    F.mkdirSync(dir, { recursive: true });
    if (quarantineCapacityReached(home, F)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let body = typeof raw === 'string' ? raw : stableJson(raw);
    if (Buffer.byteLength(body, 'utf8') > QUARANTINE_MAX_BODY_BYTES) {
      body = Buffer.from(body, 'utf8').slice(0, QUARANTINE_MAX_BODY_BYTES).toString('utf8') + '\n...[truncated at ' + QUARANTINE_MAX_BODY_BYTES + ' bytes]';
    }
    const p = path.join(dir, 'lost-batch-' + String(tag || 'unknown') + '-' + stamp + '-' + process.pid + '.raw');
    F.writeFileSync(p, body);
    return p;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// hivecontrol BINARY RESOLUTION (v0.66 — ENOENT-storm root cause)
// ---------------------------------------------------------------------------
// FIELD DEFECT (proven end-to-end): defaultMonitorRun spawned the BARE name
// `hivecontrol` with no env and no absolute path. launchd/systemd/cron give a
// unit the scheduler's MINIMAL default PATH (/usr/bin:/bin:/usr/sbin:/sbin —
// observed via `ps eww` on every installed daemon), which does not contain the
// DevSwarm CLI's install directory, so EVERY monitor call failed ENOENT ~every
// 2s (3903 errors in ~23 min across daemons; the log self-rotated every ~25 min,
// destroying all genuine ingest history).
//
// The DURABLE half of the fix lives in install-devswarm-ingest.js, which
// DISCOVERS the binary on the machine (login-shell `command -v`, never a
// hardcoded path) and bakes both PATH and ANTIHALL_DEVSWARM_HIVECONTROL into the
// generated unit, so a regenerated/reconciled unit reproduces it. THIS half is
// the daemon-side resolution: option > env var > ordinary PATH lookup. There is
// deliberately NO known-install-root probe and no per-OS path table here — this
// is a public, machine-agnostic repo; an unresolvable binary is REPORTED (once),
// never guessed.
const HIVECONTROL_ENV_VAR = 'ANTIHALL_DEVSWARM_HIVECONTROL';
const DEFAULT_HIVECONTROL_BIN = 'hivecontrol';

// resolveHivecontrolBin(explicit, env) -> { bin, source }. Mirrors
// resolveMonitorTimeoutSec's option-then-env-then-default shape (the existing
// convention in this file). `source` is 'option' | 'env' | 'path'; 'path' means
// the bare name is handed to spawn and resolved by the OS through whatever PATH
// the daemon actually inherited (which is exactly what fails on a scheduler-
// launched unit with no baked PATH — hence the installer half of this fix).
function resolveHivecontrolBin(explicit, env) {
  const opt = (typeof explicit === 'string' && explicit.trim() !== '') ? explicit.trim() : null;
  if (opt) return { bin: opt, source: 'option' };
  const raw = env && env[HIVECONTROL_ENV_VAR];
  const fromEnv = (typeof raw === 'string' && raw.trim() !== '') ? raw.trim() : null;
  if (fromEnv) return { bin: fromEnv, source: 'env' };
  return { bin: DEFAULT_HIVECONTROL_BIN, source: 'path' };
}

// hivecontrolBinUsable(resolved, F) -> true | false | null. Only an ABSOLUTE
// path can be checked here; a bare-name ('path' source) resolution is `null` =
// UNKNOWN until the OS actually tries the lookup (never reported as broken on
// speculation). Never throws.
function hivecontrolBinUsable(resolved, F) {
  const bin = resolved && resolved.bin;
  if (!bin || !path.isAbsolute(bin)) return null;
  const fsi = F || fs;
  try { if (!fsi.statSync(bin).isFile()) return false; } catch (_) { return false; }
  return true;
}

// ---------------------------------------------------------------------------
// MONITOR FAILURE CIRCUIT BREAKER (v0.66)
// ---------------------------------------------------------------------------
// ENOENT / EACCES / ENOTDIR out of the spawn are CONFIGURATION faults, not
// transient ones: retrying every 2s forever cannot fix them, it only produces a
// log storm that self-rotates real ingest history away. This mirrors the
// project's own alerting rule (a STABLE kind + an occurrences ROLLUP, never one
// entry per occurrence): the FIRST failure of a run is logged, then the backoff
// escalates and further logging happens ONLY on a state transition (a change of
// error signature or a change of backoff step) plus a time-boxed rollup line.
// TRANSIENT failures are UNCHANGED — they keep the pre-existing per-occurrence
// log + flat backoff, because those are genuinely retryable and rare.
const PERMANENT_SPAWN_ERROR_CODES = ['ENOENT', 'EACCES', 'ENOTDIR'];
// Multipliers applied to the configured base backoff, so an escalation is still
// observable when a test lowers the base (never a hardcoded 2s floor that would
// make tests sleep for real). With the production base of 2000ms this is exactly
// 2s -> 5s -> 30s -> 2min -> 5min.
const PERMANENT_BACKOFF_STEPS = [1, 2.5, 15, 60, 150];
const PERMANENT_BACKOFF_CAP_MS = 5 * 60 * 1000;
// Wall-clock gap before a still-failing breaker emits one rolled-up "still
// failing, N occurrences since T" line once the backoff ladder is capped.
const PERMANENT_ROLLUP_INTERVAL_MS = 15 * 60 * 1000;
// Longest a backoff may sleep without refreshing the daemon's liveness signals.
// MUST stay comfortably under the 3-minute HEARTBEAT_STALE_MS every consumer
// (ingest-health.js, doctor-repair.js) judges "is this daemon alive" by — see
// backoffWithHeartbeat in runIngestLoop.
const BACKOFF_HEARTBEAT_SLICE_MS = 60 * 1000;

// monitorFailureCode(res) -> 'ENOENT' | 'EACCES' | 'ENOTDIR' | null. Prefers the
// structured `code` defaultMonitorRun now propagates; falls back to matching the
// message text so an INJECTED runner (tests, and any older caller shape) that
// only supplies `error` is still classified correctly.
function monitorFailureCode(res) {
  const direct = res && res.code;
  if (typeof direct === 'string' && PERMANENT_SPAWN_ERROR_CODES.indexOf(direct) !== -1) return direct;
  const m = String((res && res.error) || '').match(/\b(ENOENT|EACCES|ENOTDIR)\b/);
  return m ? m[1] : null;
}

function permanentBackoffMs(consecutive, baseMs) {
  const n = Math.max(1, Number.isFinite(consecutive) ? consecutive : 1);
  const idx = Math.min(n - 1, PERMANENT_BACKOFF_STEPS.length - 1);
  const base = Number.isFinite(baseMs) ? baseMs : DEFAULT_RESTART_BACKOFF_MS;
  return Math.min(Math.round(base * PERMANENT_BACKOFF_STEPS[idx]), PERMANENT_BACKOFF_CAP_MS);
}

// createMonitorBreaker({ baseBackoffMs, log }) -> breaker.
//   .onFailure(res, nowMs) -> { permanent, code, backoffMs, consecutive, logged }
//   .onSuccess(nowMs)      -> { logged, recovered }
// `log(entry)` receives {kind, level, message, ctx} — injectable so tests can
// COUNT emitted lines deterministically (the whole point of the breaker) without
// parsing a log file. The default sink routes to the shared structured logger.
function createMonitorBreaker(opts) {
  const o = opts || {};
  const baseBackoffMs = Number.isFinite(o.baseBackoffMs) ? o.baseBackoffMs : DEFAULT_RESTART_BACKOFF_MS;
  const rollupMs = Number.isFinite(o.rollupIntervalMs) ? o.rollupIntervalMs : PERMANENT_ROLLUP_INTERVAL_MS;
  const emit = typeof o.log === 'function' ? o.log : function (entry) {
    if (entry.level === 'error') alog.logError('ingest', entry.kind, new Error(entry.message), entry.ctx);
    else alog.logEvent('ingest', entry.kind, entry.level, entry.message, entry.ctx);
  };
  const state = {
    consecutive: 0, signature: null, permanent: false, stepIdx: -1,
    firstAt: null, lastLogAt: null, sinceLog: 0, lastOkMs: null,
  };
  function log(entry) { try { emit(entry); } catch (_) {} }
  return {
    state,
    onFailure: function onFailure(res, nowMs) {
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      const code = monitorFailureCode(res);
      const permanent = code !== null;
      const message = String((res && res.error) || 'monitor run failed (no error detail)');
      const signature = (code || '') + '\0' + (permanent ? '' : message);
      if (!permanent) {
        // TRANSIENT — pre-existing behavior preserved verbatim: one log line per
        // occurrence, flat backoff. A transient failure also RESETS any permanent
        // run (a different fault entirely).
        state.consecutive = state.signature === signature ? state.consecutive + 1 : 1;
        state.signature = signature;
        state.permanent = false;
        state.stepIdx = -1;
        state.firstAt = state.consecutive === 1 ? now : state.firstAt;
        log({ kind: 'monitor-run-failed', level: 'error', message, ctx: Object.assign({ transient: true }, o.ctx) });
        return { permanent: false, code: null, backoffMs: baseBackoffMs, consecutive: state.consecutive, logged: true };
      }
      const sameRun = state.permanent && state.signature === signature;
      state.consecutive = sameRun ? state.consecutive + 1 : 1;
      state.signature = signature;
      state.permanent = true;
      if (!sameRun) { state.firstAt = now; state.lastLogAt = null; state.stepIdx = -1; state.sinceLog = 0; }
      state.sinceLog++;
      const backoffMs = permanentBackoffMs(state.consecutive, baseBackoffMs);
      const stepIdx = Math.min(state.consecutive - 1, PERMANENT_BACKOFF_STEPS.length - 1);
      // STATE TRANSITIONS ONLY: the first failure of this run, or a change of
      // backoff step. Plus one time-boxed rollup once the ladder is capped.
      const transitioned = stepIdx !== state.stepIdx;
      const rollupDue = !transitioned && state.lastLogAt !== null && (now - state.lastLogAt) >= rollupMs;
      state.stepIdx = stepIdx;
      if (!transitioned && !rollupDue) {
        return { permanent: true, code, backoffMs, consecutive: state.consecutive, logged: false };
      }
      const ctx = Object.assign({
        code, permanent: true, consecutiveFailures: state.consecutive,
        occurrencesSinceLastLog: state.sinceLog, failingSince: state.firstAt,
        nextRetryInMs: backoffMs,
      }, o.ctx);
      log({
        kind: 'monitor-run-failed-permanent',
        level: 'error',
        message: (state.consecutive === 1
          ? 'monitor spawn failed with a CONFIGURATION error (' + code + '): ' + message
          : 'monitor spawn still failing (' + code + '), ' + state.consecutive + ' consecutive occurrence(s) since '
            + new Date(state.firstAt).toISOString())
          + ' — retrying is futile until it is fixed. Resolve the hivecontrol binary: set '
          + HIVECONTROL_ENV_VAR + ' to its absolute path, or re-run the ingest installer so the'
          + ' scheduler unit bakes the resolved path/PATH. Backing off ' + backoffMs + 'ms.',
        ctx,
      });
      state.lastLogAt = now;
      state.sinceLog = 0;
      return { permanent: true, code, backoffMs, consecutive: state.consecutive, logged: true };
    },
    onSuccess: function onSuccess(nowMs) {
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      const recovered = state.consecutive > 0;
      const wasPermanent = state.permanent;
      const wasCount = state.consecutive;
      state.consecutive = 0; state.signature = null; state.permanent = false;
      state.stepIdx = -1; state.sinceLog = 0; state.lastLogAt = null; state.firstAt = null;
      state.lastOkMs = now;
      if (recovered && wasPermanent) {
        log({
          kind: 'monitor-run-recovered', level: 'warn',
          message: 'monitor spawn recovered after ' + wasCount + ' consecutive configuration failure(s)',
          ctx: Object.assign({ consecutiveFailures: wasCount }, o.ctx),
        });
        return { logged: true, recovered: true };
      }
      return { logged: false, recovered };
    },
  };
}

// defaultMonitorRun({ hivecontrol, intervalSec, timeoutSec }) -> { ok, raw, error }.
// Runs ONE `hivecontrol workspace monitor` invocation (it long-polls, then exits
// when messages arrive or the timeout elapses) and returns its raw stdout. A
// timeout is normal (no messages this window) -> ok:true, raw:'' . Injectable via
// opts.run so tests never spawn a real binary.
function defaultMonitorRun(opts) {
  const o = opts || {};
  const bin = o.hivecontrol || 'hivecontrol';
  const args = ['workspace', 'monitor'];
  if (Number.isFinite(o.intervalSec)) { args.push('-i', String(o.intervalSec)); }
  if (Number.isFinite(o.timeoutSec)) { args.push('-t', String(o.timeoutSec)); }
  try {
    const r = spawnSync(bin, args, {
      encoding: 'utf8',
      timeout: Number.isFinite(o.hardTimeoutMs) ? o.hardTimeoutMs : undefined,
    });
    // A spawn error (including a hardTimeoutMs kill) does NOT mean stdout is empty —
    // Node's spawnSync PRESERVES whatever the child already wrote before it was
    // killed (verified: an ETIMEDOUT result still carries r.stdout). `hivecontrol
    // workspace monitor` is DESTRUCTIVE — it pops messages off the native queue as
    // it prints them — so discarding r.stdout here would silently and PERMANENTLY
    // lose whatever batch was drained right before the kill fired (P1-A fix). The
    // caller (runIngestLoop) still ingests this raw output even though ok is false.
    // `code` (v0.66) is what lets the caller tell a PERMANENT configuration
    // fault (ENOENT — binary not on the daemon's PATH; EACCES; ENOTDIR) from a
    // transient one (ETIMEDOUT from hardTimeoutMs, a crashed child). It used to
    // be discarded into the message string, so every fault looked retryable and
    // the loop hammered a missing binary every 2s forever.
    if (r.error) {
      return {
        ok: false, raw: String(r.stdout || ''),
        error: String(r.error.message || r.error),
        code: r.error.code ? String(r.error.code) : null,
      };
    }
    return { ok: true, raw: String(r.stdout || ''), error: null, code: null };
  } catch (e) {
    return { ok: false, raw: '', error: String(e && e.message || e), code: (e && e.code) ? String(e.code) : null };
  }
}

// resolveMonitorTimeoutSec(explicit, env) -> number. Explicit opts.timeoutSec always wins
// (tests/tuning can still force a specific or unbounded* value). Otherwise the
// ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC env var configures the bounded cadence.
// Otherwise DEFAULT_MONITOR_TIMEOUT_SEC. (*passing a genuinely unbounded monitor call
// is only ever done explicitly — the production main() below never does.)
function resolveMonitorTimeoutSec(explicit, env) {
  if (Number.isFinite(explicit)) return explicit;
  const raw = env && env.ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC;
  const n = raw != null ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_MONITOR_TIMEOUT_SEC;
}

// readInstalledPluginVersion(fsi) -> semver string | null. Best-effort read of
// THIS daemon's own installed plugin.json version (companion/devswarm-ingest.js
// -> ../.claude-plugin/plugin.json — one directory up from this file, resolved
// via __dirname so it always names the plugin build actually LOADED into this
// process, never the caller's cwd). Stamped into every heartbeat (see
// writeIngestHeartbeat) so doctor/update can detect a RUNNING daemon that is
// still executing pre-update code after `git pull` lands new content at the
// stable path but does not itself restart the process (the pacing-fix gap this
// stamp exists to close). Fail-open to null — a missing/unreadable/malformed
// plugin.json must never crash the loop; null is treated as "pre-stamp code"
// (older than any real semver) by every consumer, which is the correct
// conservative default.
function readInstalledPluginVersion(fsi) {
  const F = fsi || fs;
  try {
    const p = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
    const json = JSON.parse(F.readFileSync(p, 'utf8'));
    return (json && typeof json.version === 'string') ? json.version : null;
  } catch (_) { return null; }
}

// logFilePath(home) — the SAME stable log install-devswarm-ingest.js wires
// launchd's StandardOutPath/StandardErrorPath, systemd's StandardOutput/
// StandardError, and the cron fallback's `>> ... 2>&1` into
// (~/.anti-hall/devswarm-ingest.log). Keeping the path derivation identical on
// both sides means a startup failure is diagnosable from ONE file regardless of
// which scheduler launched the daemon.
function logFilePath(home) {
  return path.join(home || os.homedir(), '.anti-hall', 'devswarm-ingest.log');
}

// appendLog(home, line, fsi) — best-effort timestamped append. A startup
// failure (bad lock, store-open error) used to exit silently, leaving nothing to
// diagnose; every call here writes a `[ISO] <line>` entry BEFORE the caller acts
// on the failure. Fully fail-open: a logging failure (disk full, permissions)
// is swallowed and must NEVER mask or replace the error it was trying to record.
function appendLog(home, line, fsi) {
  const F = fsi || fs;
  try {
    const p = logFilePath(home);
    F.mkdirSync(path.dirname(p), { recursive: true });
    F.appendFileSync(p, '[' + new Date().toISOString() + '] ' + line + '\n');
  } catch (_) { /* fail-open: a logging failure must never mask the original error */ }
}

// runIngestLoop(opts) -> summary. The supervised daemon body. Acquires the
// single-consumer lock (refuses if held), opens the store, then loops:
//   monitor once -> ingest -> deriveSummary -> (on child exit/crash) backoff and
//   re-spawn. Bounded by opts.maxIterations for tests; unbounded (Infinity) as a
//   real daemon. opts.run is the injectable monitor runner; opts.sleep the clock.
function runIngestLoop(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  // Resolve the worktree this daemon runs FROM (launchd/systemd bake it as the unit's
  // WorkingDirectory). Explicit o.worktree wins (deterministic in tests); passing
  // o.worktree===null forces the legacy global lock; otherwise resolve from
  // o.cwd/process.cwd(). Both lock keying AND the store partition (workspaceId) derive
  // from it so two daemons for DIFFERENT repos never collide (#15).
  const worktree = ('worktree' in o) ? o.worktree : resolveDaemonWorktree(o.cwd);
  // WORKTREE IS GROUND TRUTH for this daemon's own identity (mirrors devswarm.js's
  // callerIdentity P0 fix): a resolved worktree's primaryWorkspaceId is authoritative
  // over env.DEVSWARM_BUILDER_ID. Without this, a daemon that happens to inherit a
  // DEVSWARM_BUILDER_ID naming a CHILD workspace (ordinary env inheritance from a
  // parent process, or a stray export) would ingest AND self-register under that
  // child's id — clobbering the child's registry row and splitting the store
  // partition the worktree actually owns. No installed launchd/systemd/cron unit
  // ever bakes DEVSWARM_BUILDER_ID (audit-confirmed — see buildPlist/buildService/
  // buildCronLine in install-devswarm-ingest.js), so worktree-derived IS the real
  // installed daemon's identity; env is trusted ONLY as a fallback when the
  // worktree does not resolve at all (no ground truth to contradict it). Explicit
  // o.workspaceId (test override) still wins over both — unchanged.
  const workspaceId = o.workspaceId
    || (worktree ? installIngest.primaryWorkspaceId(worktree) : null)
    || (o.env && o.env.DEVSWARM_BUILDER_ID)
    || 'primary';
  // v0.57 mesh (D1/D8/D21): repoKey is the SHARED-STORE key this daemon drains
  // into — DISTINCT from `workspaceId` above (the self-registered id, worktree-
  // hash based, D19 — never re-keyed). null (repoKey unresolvable — a fake/
  // non-git worktree, the direct unit-test posture) is fail-open: every repoKey
  // consumer below falls back to its EXISTING pre-mesh behavior.
  const repoKey = worktree ? safeRepoKey(worktree) : null;
  const hbHash = repoKey || (worktree ? safeWorktreeHash(worktree) : workspaceId);
  const run = o.run || defaultMonitorRun;
  const sleep = o.sleep || sleepSync;
  const maxIterations = Number.isFinite(o.maxIterations) ? o.maxIterations : Infinity;
  const backoffMs = Number.isFinite(o.restartBackoffMs) ? o.restartBackoffMs : DEFAULT_RESTART_BACKOFF_MS;
  const intervalSec = Number.isFinite(o.intervalSec) ? o.intervalSec : DEFAULT_MONITOR_INTERVAL_SEC;
  const timeoutSec = resolveMonitorTimeoutSec(o.timeoutSec, o.env);
  // hardTimeoutMs (P0 fix): a hard OS-level kill bound on the spawned hivecontrol
  // child (defaultMonitorRun's spawnSync `timeout` option), a margin beyond the
  // monitor's own soft `-t timeoutSec` deadline. Production (main() below) never
  // set this before, so a hivecontrol child that doesn't honor its own -t (hang,
  // wedged subprocess, network stall) blocks spawnSync — and thus this WHOLE
  // daemon, including its lock heartbeat (heartbeat only advances BETWEEN loop
  // iterations, see the loop below) — indefinitely. acquireIngestLock's isAlive()
  // check then correctly (by design, see its STEAL RULE comment) refuses to steal a
  // lock whose holder is genuinely still alive, so every OTHER starter is refused
  // for as long as the hang lasts (observed in production: hours, far past
  // INGEST_LOCK_STALE_MS — see devswarm-ingest.log). Bounding the child lets a
  // wedged/non-cooperative monitor call be force-killed so the loop can continue
  // (spawnSync's timeout kill surfaces as res.ok:false via defaultMonitorRun's
  // existing `r.error` branch -> the existing "crash -> backoff then re-spawn" path
  // below, unchanged) instead of parking the daemon — and its lock — forever.
  // Explicit o.hardTimeoutMs (tests / tuning) still wins.
  const hardTimeoutMs = Number.isFinite(o.hardTimeoutMs) ? o.hardTimeoutMs : (timeoutSec * 1000) + 10000;

  // hivecontrol binary — resolved ONCE per daemon process (option > env var >
  // ordinary PATH lookup) and reused for every iteration, so a scheduler-
  // launched unit that baked ANTIHALL_DEVSWARM_HIVECONTROL spawns the ABSOLUTE
  // binary instead of a bare name the minimal launchd/systemd PATH cannot find.
  const hivecontrol = resolveHivecontrolBin(o.hivecontrol, o.env);
  const monitorLogSink = (o.io && typeof o.io.monitorLog === 'function') ? o.io.monitorLog : null;
  const breaker = createMonitorBreaker({
    baseBackoffMs: backoffMs,
    rollupIntervalMs: o.monitorRollupIntervalMs,
    log: monitorLogSink,
    ctx: { workspaceId, hivecontrol: hivecontrol.bin, hivecontrolSource: hivecontrol.source, hardTimeoutMs, timeoutSec },
  });
  // Monitor OUTCOME state mirrored into every heartbeat (see writeIngestHeartbeat)
  // so "alive but ingesting nothing" is machine-detectable from the heartbeat file
  // ALONE — previously the heartbeat was written unconditionally BEFORE the monitor
  // call and therefore reported a permanently-failing daemon as perfectly RUNNING.
  const monitorState = {
    lastMonitorOkMs: null, consecutiveMonitorFailures: 0,
    lastMonitorErrorCode: null, lastMonitorError: null,
    hivecontrolBin: hivecontrol.bin, hivecontrolSource: hivecontrol.source,
    daemonPath: (o.env && typeof o.env.PATH === 'string') ? o.env.PATH : null,
    // CODE-VERSION STAMP (resolved ONCE per daemon process, like hivecontrol
    // above, and reused for every heartbeat): lets doctor/update detect a
    // still-running daemon that never re-exec'd after `git pull` landed newer
    // content at the stable ExecStart path — see readInstalledPluginVersion.
    // o.pluginVersion (test override) wins over the real on-disk read.
    codeVersion: o.pluginVersion != null ? String(o.pluginVersion) : readInstalledPluginVersion(o.io && o.io.storeFs),
    startedAtMs: Number.isFinite(o.startedAtMs) ? o.startedAtMs : Date.now(),
  };

  const logFs = o.io && o.io.logFs;
  const release = (o.io && o.io.lock) ? o.io.lock(home) : acquireIngestLock(home, o.io, worktree);
  if (!release) {
    const reason = 'another monitor consumer is already running (ingest lock held)';
    appendLog(home, 'ingest daemon refused to start: ' + reason, logFs);
    return { ok: false, started: false, reason };
  }
  // SIGNAL HANDLER (kept, but NOT relied on for correctness — see below). A normal
  // return/throw already releases the lock via the `finally` below; these handlers
  // additionally trap SIGTERM (launchd stopping/restarting this unit) and SIGINT
  // (Ctrl-C) so a release ALSO happens on that path, WHEN THE HANDLER ACTUALLY GETS
  // A CHANCE TO RUN. It does not always get that chance: Node cannot execute a JS
  // signal handler while the event loop is blocked inside a synchronous call, and
  // this daemon spends its entire risky window blocked inside `spawnSync` (the
  // monitor child call below). A signal that arrives during that window is simply
  // not delivered to this handler until spawnSync returns — so this handler CANNOT
  // close the leaked-lock window for that case (Node does not preempt a blocking
  // syscall to dispatch a JS signal handler). What actually guarantees recovery
  // from a lock left behind by a killed daemon is dead-holder-immediate-reclaim in
  // acquireIngestLock (P1-B, see its STEAL RULE comment above), combined with
  // hardTimeoutMs (below) bounding how long the spawnSync block itself can last.
  // These handlers remain useful — and harmless — for the ordinary case where the
  // daemon is signaled OUTSIDE the blocking spawn (e.g. between iterations), so
  // they stay registered. `proc` is injectable via io.process (same DI seam as
  // io.fs/io.isAlive/io.now/io.lock above) so tests can capture + invoke the handler
  // deterministically instead of sending a real OS signal to the test worker.
  const proc = (o.io && o.io.process) || process;
  const onSignal = function onSignal() {
    try { release(); } catch (_) {}
    proc.exit(0);
  };
  proc.on('SIGTERM', onSignal);
  proc.on('SIGINT', onSignal);

  // ORPHANED-LOCK SWEEP (v0.65). We hold our own lock now, so every OTHER ingest
  // lock in the directory belongs to someone else — sweep the ones whose recorded
  // holder is PROVABLY not running (dead pid / recycled pid / defunct) before the
  // first drain. Our own lock is passed as skipPath and is never considered. This
  // is the counter-measure to leaked locks accumulating unboundedly (the field
  // case: 58 files, 52 dead owners), each of which becomes a permanent refusal the
  // moment its pid number is recycled. Bounded, idempotent, never signals anything,
  // and fully fail-open — a sweep failure must never abort daemon startup.
  if (!(o.io && o.io.skipLockSweep)) {
    try { sweepOrphanedIngestLocks(home, o.io, ingestLockPath(home, worktree)); } catch (e) {
      alog.logError('lock', 'sweep-orphaned-ingest-locks-failed', e, { workspaceId });
    }
  }

  // REAP-BEFORE-DRAIN PROBE (D9/D21, Phase5 step 3). Before this daemon's FIRST
  // `monitor`, check EVERY legacy per-worktree lock file belonging to this repo
  // (enumerated via `git worktree list --porcelain` from the baked Primary
  // worktree — Gap-2: worktreeHash is one-way and cannot be inverted, so this is
  // the ONLY correct way to recover "which legacy units belong to this repo").
  // While ANY legacy holder is still ALIVE, this daemon backs off entirely — it
  // NEVER opens the store or calls `monitor` — because two concurrent `monitor`
  // consumers on the SAME Primary native queue would split it between them
  // (silent loss, the exact single-consumer break the invariant forbids). The
  // install path (install-devswarm-ingest.js) is expected to stop the legacy
  // unit BEFORE loading this daemon; this probe is the daemon's OWN independent
  // verification that the hand-off actually completed (its unload is NOT trusted
  // to have succeeded — launchctl/systemctl errors are ignored at install time).
  // Skipped entirely when repoKey is unresolvable (fail-open — nothing to probe
  // against; matches the direct unit-test posture with a fake worktree).
  if (repoKey && !(o.io && o.io.skipLegacyProbe)) {
    const probe = probeLegacyHolders(home, worktree, o.io);
    if (probe.blocked) {
      const reason = 'legacy per-worktree ingest holder(s) still alive for this repo — backing off before first drain (reap-before-drain, D9): '
        + probe.liveHolders.map((h) => h.worktree + ' (pid ' + h.pid + ')').join(', ');
      appendLog(home, 'ingest daemon refused to start: ' + reason, logFs);
      try { release(); } catch (_) {}
      try { proc.removeListener('SIGTERM', onSignal); } catch (_) {}
      try { proc.removeListener('SIGINT', onSignal); } catch (_) {}
      return { ok: false, started: false, reason, liveHolders: probe.liveHolders };
    }
  }

  const openStore = (o.io && o.io.openStore) || store.openStore;
  const stats = { iterations: 0, inserted: 0, duplicate: 0, errors: 0, lossEvents: 0 };
  // QUARANTINE RATE LIMIT (P1 fix, paired with the file-count/body-size caps on
  // quarantineLossyMonitorBatch itself): at most one quarantine WRITE + one
  // 'error'-level log line per QUARANTINE_RATE_LIMIT_MS, no matter how fast the
  // loop cycles (a fast-returning/hot-spinning monitor call must not turn into
  // a write-per-poll log storm). stats.lossEvents still counts every real loss
  // occurrence; only the WRITE/LOG side is throttled, with suppressed
  // occurrences rolled into the next line that does fire.
  const QUARANTINE_RATE_LIMIT_MS = 30 * 1000;
  let lastQuarantineWriteAt = null;
  let quarantineSuppressedCount = 0;
  let s = null;
  try {
    // SHARED PER-PROJECT store (D1/D8/D21): this daemon opens the PROJECT's
    // repoKey-keyed store (store/<repoKey>/) when repoKey resolves — the same
    // store `mesh send`/`roster`/`register` target — so a native-drained message
    // lands where every mesh consumer reads it. `workspaceId` (self-registration
    // id, worktree-hash based, D19) is UNCHANGED — it selects the PARTITION
    // inside that shared store, not which physical store file is opened.
    // repoKey===null (unresolvable) falls back to the PRE-MESH behavior
    // (hash derived from workspaceId) — fail-open, never a hard error.
    // Opening the store is part of STARTUP (not just the loop), so it lives inside
    // this try — a startup failure here (bad backend, unwritable store dir) is
    // logged the same way a mid-loop failure is, instead of exiting silently.
    s = openStore({
      home, workspaceId, hash: repoKey || undefined,
      backend: o.backend, env: o.env, fsi: (o.io && o.io.storeFs),
    });
    appendLog(home, 'ingest daemon started, worktree=' + (worktree || '(unresolved)') + ', workspaceId=' + workspaceId
      + ', hivecontrol=' + hivecontrol.bin + ' (' + hivecontrol.source + ')', logFs);
    // DEGRADED-MODE STARTUP NOTICE, emitted EXACTLY ONCE (never per iteration —
    // that is the storm this whole change exists to kill). Only an ABSOLUTE
    // configured path can be checked up front; a bare-name resolution is left to
    // the OS and, if it fails, is reported once by the circuit breaker's first
    // permanent-failure line instead. Fail-open: this is a notice, never a gate —
    // the daemon still starts (it must keep its lock + heartbeat so doctor can
    // SEE the fault) and the breaker bounds the retry cost.
    if (hivecontrolBinUsable(hivecontrol, (o.io && o.io.storeFs)) === false) {
      const msg = 'WARN: configured hivecontrol binary is not a readable file: ' + hivecontrol.bin
        + ' (source: ' + hivecontrol.source + '). Set ' + HIVECONTROL_ENV_VAR
        + ' to the absolute path of the hivecontrol CLI, or re-run the ingest installer so the'
        + ' scheduler unit bakes the resolved path. Ingest will run in DEGRADED mode (backed-off retries).';
      appendLog(home, msg, logFs);
      if (monitorLogSink) { try { monitorLogSink({ kind: 'hivecontrol-unresolvable', level: 'error', message: msg, ctx: { bin: hivecontrol.bin, source: hivecontrol.source } }); } catch (_) {} }
      else alog.logError('ingest', 'hivecontrol-unresolvable', new Error(msg), { bin: hivecontrol.bin, source: hivecontrol.source });
    }

    // SELF-REGISTRATION (#34 fix): register THIS daemon's own primary/worktree id in
    // the registry so deriveSummary's workspaces{} projection (which iterates ONLY
    // store.listRegistry() ids — see devswarm-store.js deriveSummary ~638) actually
    // includes this daemon's own partition. Without this, nothing on any real
    // runtime path ever registers `primary-<hash>` (only the CLI's explicit
    // `register-primary` did) — messages land in the messages table via
    // appendMessage below, but workspaces['primary-<hash>'] never existed, so
    // parent-gate's readOwnUnread and parent-inbox's own-unread always read 0 even
    // with real unread messages sitting in the store. upsertRegistry is an
    // idempotent UPSERT (ON CONFLICT DO UPDATE — sqlite; latest-row-wins — journal),
    // so calling it every startup is safe and self-heals a missing/stale row. Only
    // this daemon's OWN id is registered here — never a child id — and a distinct id
    // means an existing child registry row is never touched.
    //
    // MERGE-PRESERVING (matches hooks/devswarm-child-turn.js's registerChildDescriptor
    // read-before-write pattern): a prior explicit `register-primary` CLI call may
    // have written a fuller row (real inboxPath/cursorPath/nudgeCommand). upsertRegistry
    // itself has no partial-update support (both backends always write all fields —
    // see devswarm-store.js), so every startup would otherwise null those fields back
    // out. Read the existing row first and carry its projected fields forward instead
    // of clobbering them; fail-open to null (the prior, harmless behavior) if the read
    // itself errors.
    try {
      let existing = null;
      try {
        const rows = typeof s.listRegistry === 'function' ? s.listRegistry() : [];
        existing = (rows || []).find((r) => r && String(r.id) === String(workspaceId)) || null;
      } catch (_) { existing = null; }
      s.upsertRegistry({
        id: workspaceId,
        worktreePath: worktree || null,
        sessionId: (o.env && o.env.DEVSWARM_BUILDER_ID) || workspaceId || null,
        inboxPath: existing ? existing.inboxPath : null,
        cursorPath: existing ? existing.cursorPath : null,
        nudgeCommand: existing ? existing.nudgeCommand : null,
      });
    } catch (e) {
      // FAIL-OPEN: a registry-write error must NEVER crash or block the daemon's
      // core drain — messages still get ingested even if self-registration hiccups
      // (retried every startup, so a transient failure self-heals).
      appendLog(home, 'WARN: self-registration failed (workspaceId=' + workspaceId + '): '
        + (e && e.message ? e.message : String(e)), logFs);
    }

    // backoffWithHeartbeat(totalMs) — sleep the (possibly LONG) monitor backoff in
    // slices, refreshing BOTH liveness signals before each slice.
    //
    // WHY SLICES: the permanent-fault ladder escalates to 5 minutes, but a daemon
    // is judged DEAD once its heartbeat is older than HEARTBEAT_STALE_MS (3 min,
    // ingest-health.js / doctor). Sleeping 5 minutes in one call would therefore
    // make a correctly-backing-off daemon read as STOPPED — collapsing the new,
    // precise "alive but its monitor calls are failing" diagnosis back into the
    // generic "dead daemon" it is meant to replace, and (worse) letting the lock's
    // own ts go stale enough to be considered for a wedge-steal while the daemon
    // is perfectly healthy. Slicing keeps both signals honest during the backoff
    // WITHOUT shortening it. One slice always runs, so a failure's updated
    // counters reach the heartbeat immediately rather than one cycle later.
    function backoffWithHeartbeat(totalMs) {
      let remaining = Math.max(0, Number.isFinite(totalMs) ? totalMs : 0);
      do {
        if (release && typeof release.heartbeat === 'function') {
          try { release.heartbeat(o.now); } catch (_) {}
        }
        writeIngestHeartbeat(home, hbHash, Object.assign({ workspaceId, workingDir: worktree, now: o.now }, monitorState), (o.io && o.io.storeFs));
        const slice = Math.min(remaining, BACKOFF_HEARTBEAT_SLICE_MS);
        sleep(slice);
        remaining -= slice;
      } while (remaining > 0);
    }

    for (let i = 0; i < maxIterations; i++) {
      if (o.shouldStop && o.shouldStop()) break;
      // Heartbeat our lock each iteration so this live, long-lived consumer keeps
      // its timestamp fresh and can never be mistaken for a stale holder + stolen.
      if (release && typeof release.heartbeat === 'function') {
        try { release.heartbeat(o.now); } catch (_) {}
      }
      // Per-worktree DAEMON liveness heartbeat, written EVERY sweep regardless of
      // whether anything was ingested — a live-but-quiet daemon must still read as
      // alive. Fail-open: a heartbeat-write error must never crash the loop.
      writeIngestHeartbeat(home, hbHash, Object.assign({ workspaceId, workingDir: worktree, now: o.now }, monitorState), (o.io && o.io.storeFs));
      // PACING (P0 fix): `run` is expected to long-poll for ~intervalSec on its
      // own (hivecontrol's -i/-t flags), but in production hivecontrol can and
      // does return in well under a second — with nothing here to slow it back
      // down, the loop busy-spins at multiple iterations/sec, each doing a full
      // fork/exec/reap of the hivecontrol binary. That drove both a sustained
      // macOS kernel-allocator leak (data.kalloc.1024, ~220/sec observed) and
      // ~11% steady-state CPU from a daemon that should be idling between polls.
      // iterationStart is real Date.now() (NOT the injectable o.now, which tests
      // use as a fixed business-logic timestamp and would make elapsed always 0)
      // so pacing reflects actual wall-clock spend regardless of test overrides.
      const iterationStart = Date.now();
      const res = run({
        hivecontrol: hivecontrol.bin, intervalSec,
        timeoutSec, hardTimeoutMs,
      });
      stats.iterations++;
      // P1-A fix: a FAILED attempt (timeout/crash) can still carry drained stdout —
      // `hivecontrol workspace monitor` is DESTRUCTIVE (it pops messages off the
      // native queue as it prints them), and Node's spawnSync preserves whatever
      // the child already wrote before it was killed. Ingest that output
      // UNCONDITIONALLY whenever non-empty, BEFORE the ok-check below, so a
      // killed-mid-print monitor call never discards messages that were already
      // popped off the native queue — they would otherwise be lost forever (the
      // next poll cannot re-observe them). The attempt still counts as a failure
      // for backoff purposes afterward (see the `!res.ok` check below).
      if (res.raw) {
        let ing;
        try {
          ing = ingestPayload(s, res.raw, { workspaceId, now: o.now });
        } catch (e) {
          // STORE-LOCK FAIL-CLOSED errors must not CRASH-LOOP the daemon. appendMessage
          // fails closed on ELOCKFS (a genuine fs/EPERM error on the messages lock) and
          // ELOCKUNAVAIL (contention budget exhausted) — correct, but if that throw
          // propagates out of the loop the daemon exits and is re-exec'd every RESTART_SEC,
          // hammering the same wedged lock. The native queue BUFFERS until the next monitor
          // poll and replay is idempotent by hash, so on these two known-retryable lock
          // signals we LOG and CONTINUE to the next poll instead of crashing. Any OTHER
          // error still propagates (fail-open is only for the lock signals, not arbitrary bugs).
          if (e && (e.code === 'ELOCKFS' || e.code === 'ELOCKUNAVAIL')) {
            stats.errors++;
            try { fs.writeSync(2, 'devswarm-ingest: store lock ' + e.code + ' — skipping this batch, replaying next poll (idempotent by hash)\n'); } catch (_) {}
            alog.logError('ingest', 'ingest-payload-retryable', e, { workspaceId, code: e.code });
            if (i + 1 < maxIterations) sleep(backoffMs);
            continue;
          }
          throw e;
        }
        stats.inserted += ing.inserted;
        stats.duplicate += ing.duplicate;
        if (ing.inserted > 0) store.deriveSummary(s, { home, env: o.env, now: o.now });
        // B1 LOSS EVENT: `raw` was substantive (not the ordinary empty/
        // whitespace quiet-poll case — see ingestPayload's own doc) but
        // normalized to ZERO messages. The native queue already popped these
        // bytes; there is nothing left to retry. Quarantine what we have and
        // log it via the shared structured logger so this is never a silent,
        // permanent loss (a truncated hardTimeoutMs-killed print, stderr
        // contamination, or an output-shape change would otherwise vanish
        // with nothing but a bumped counter to show for it).
        if (ing.lossy) {
          stats.lossEvents++;
          const nowMs = Number.isFinite(o.now) ? o.now : Date.now();
          const dueForWrite = lastQuarantineWriteAt === null || (nowMs - lastQuarantineWriteAt) >= QUARANTINE_RATE_LIMIT_MS;
          if (!dueForWrite) {
            // Rate-limited: count it, but do not write another file or emit
            // another log line this window — the next line that does fire
            // rolls this occurrence into its suppressed-count.
            quarantineSuppressedCount++;
          } else {
            const rawBody = typeof res.raw === 'string' ? res.raw : stableJson(res.raw);
            const byteLen = Buffer.byteLength(rawBody, 'utf8');
            const capped = quarantineCapacityReached(home, (o.io && o.io.storeFs));
            const qPath = capped ? null : quarantineLossyMonitorBatch(home, res.raw, hbHash, (o.io && o.io.storeFs));
            const suppressed = quarantineSuppressedCount;
            alog.logEvent('ingest', 'monitor-batch-normalized-to-zero', 'error',
              'hivecontrol monitor returned ' + byteLen + ' non-empty byte(s) but the batch shape was unrecognized '
                + '(unparseable, or parseable JSON matching none of the known batch shapes) — the native queue is '
                + 'destructive so this batch is otherwise UNRECOVERABLE'
                + (qPath ? '; quarantined to ' + qPath
                  : (capped ? ' (quarantine directory at its ' + QUARANTINE_MAX_FILES + '-file cap — not written, existing files preserved)'
                    : ' (quarantine write also failed — see raw byte length above)'))
                + (suppressed > 0 ? '; ' + suppressed + ' additional loss event(s) suppressed since the last quarantine write/log (rate-limited to 1 per ' + Math.round(QUARANTINE_RATE_LIMIT_MS / 1000) + 's)' : ''),
              { workspaceId, bytes: byteLen, quarantinePath: qPath, quarantineCapped: capped, suppressedSinceLastLog: suppressed });
            lastQuarantineWriteAt = nowMs;
            quarantineSuppressedCount = 0;
          }
        }
      }
      // H3: `!res.ok` covers both a genuine monitor crash AND a hardTimeoutMs
      // kill (the spawnSync `timeout` option in defaultMonitorRun — see its own
      // and hardTimeoutMs's comments above). Either way this is a TRANSIENT,
      // already-handled condition — res.raw was already ingested above when
      // non-empty, and the loop backs off then continues to the next poll
      // (graceful degrade, never a hang) — but it must be OBSERVABLE, not just
      // silently absorbed into stats.errors.
      if (!res.ok) {
        stats.errors++;
        // CIRCUIT BREAKER (v0.66). A PERMANENT (configuration) fault escalates the
        // backoff and logs only on state transitions + a periodic rollup; a
        // TRANSIENT one keeps the pre-existing per-occurrence log + flat backoff.
        // NOTE the ordering above is deliberately UNCHANGED: res.raw is ingested
        // BEFORE we ever get here, so a monitor killed mid-print never loses the
        // batch it already popped off the destructive native queue.
        const verdict = breaker.onFailure(res, Number.isFinite(o.now) ? o.now : Date.now());
        monitorState.consecutiveMonitorFailures = verdict.consecutive;
        monitorState.lastMonitorErrorCode = verdict.code;
        monitorState.lastMonitorError = String(res.error || 'monitor run failed (no error detail)').slice(0, 300);
        stats.monitorFailures = verdict.consecutive;
        stats.monitorPermanent = !!verdict.permanent;
        if (i + 1 < maxIterations) backoffWithHeartbeat(verdict.backoffMs); // crash -> backoff then re-spawn
        continue;
      }
      // A SUCCESSFUL monitor call clears the breaker and stamps lastMonitorOkMs,
      // which the NEXT sweep's heartbeat carries (the heartbeat is written once
      // per cycle, at the top — see writeIngestHeartbeat's call above), so a
      // consumer (doctor) can tell "alive AND actually draining" from "alive but
      // ingesting nothing" without parsing any log.
      breaker.onSuccess(Number.isFinite(o.now) ? o.now : Date.now());
      monitorState.lastMonitorOkMs = breaker.state.lastOkMs;
      monitorState.consecutiveMonitorFailures = 0;
      monitorState.lastMonitorErrorCode = null;
      monitorState.lastMonitorError = null;
      stats.monitorFailures = 0;
      stats.monitorPermanent = false;
      // Pace the SUCCESS path to at most ~once per intervalSec regardless of how
      // fast `run` actually returned (see the iterationStart comment above). A
      // negative/NaN/zero intervalSec (bad opts) falls back to
      // DEFAULT_MONITOR_INTERVAL_SEC rather than spinning unpaced. Routed through
      // the EXISTING backoffWithHeartbeat (not a raw sleep) so lock/heartbeat
      // liveness slicing during the wait is preserved — same as the failure path.
      // Skipped on the final iteration: nothing left to pace before.
      if (i + 1 < maxIterations) {
        const paceIntervalSec = Number.isFinite(intervalSec) && intervalSec > 0
          ? intervalSec : DEFAULT_MONITOR_INTERVAL_SEC;
        const elapsed = Date.now() - iterationStart;
        const pace = Math.max(0, (paceIntervalSec * 1000) - elapsed);
        if (pace > 0) backoffWithHeartbeat(pace);
      }
    }
  } catch (e) {
    // Startup (store-open) AND main-loop failures land here. Fail-open: APPEND a
    // timestamped ERROR+stack line BEFORE this rethrows — today a startup failure
    // exits silently, leaving nothing to diagnose. appendLog is itself fully
    // try/catch-wrapped and can never mask this rethrow.
    appendLog(home, 'ERROR: ' + (e && e.message ? e.message : String(e)) + (e && e.stack ? ('\n' + e.stack) : ''), logFs);
    alog.logError('ingest', 'run-ingest-loop-fatal', e, { workspaceId });
    throw e;
  } finally {
    // Adaptive hardening (item 4): these were previously bare `catch (_) {}` —
    // a close/release failure during shutdown is unexpected (not one of the
    // documented "expected absent/torn state" cases elsewhere in this file) and
    // is now logged for diagnosis. Still fully fail-open: logging never throws
    // (alog's own contract) and this finally block must still complete its
    // cleanup regardless of any one step's outcome.
    try { if (s) s.close(); } catch (e) { alog.logError('ingest', 'store-close-failed', e, { workspaceId }); }
    try { release(); } catch (e) { alog.logError('lock', 'release-failed', e, { workspaceId }); }
    try { proc.removeListener('SIGTERM', onSignal); } catch (_) {}
    try { proc.removeListener('SIGINT', onSignal); } catch (_) {}
  }
  return { ok: true, started: true, workspaceId, stats };
}

function sleepSync(ms) {
  try { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, Math.max(0, ms | 0)); } catch (_) {}
}

// resolveDaemonWorktree(cwd) — the daemon's own worktree (git toplevel of its baked
// WorkingDirectory), computed with the SAME resolver the installer used, so the hash
// agrees. null when cwd is not inside a git worktree.
function resolveDaemonWorktree(cwd) {
  try { return installIngest.resolveWorktree(cwd || process.cwd()); } catch (_) { return null; }
}
// safeWorktreeHash(wt) — never throws (heartbeat keying must be fail-open).
function safeWorktreeHash(wt) {
  try { return installIngest.worktreeHash(wt); } catch (_) { return null; }
}
// safeRepoKey(wt) — never throws (fail-open; a fake/non-existent worktree path —
// the direct unit-test posture — yields null, never an error).
function safeRepoKey(wt) {
  try { return repokey.repoKeyForWorktree(wt); } catch (_) { return null; }
}

// legacyIngestLockPath(home, worktree) — the OLD per-worktree lock shape
// (locks/ingest-<worktreeHash>.lock), used ONLY by the reap-before-drain PROBE
// below to check whether a legacy per-worktree daemon for a GIVEN worktree of
// this repo is still alive. Deliberately distinct from ingestLockPath (which now
// prefers the repoKey shape) — the probe always needs the PRE-MESH name.
function legacyIngestLockPath(home, worktree) {
  return path.join(devswarmRoot(home), 'locks', 'ingest-' + installIngest.worktreeHash(worktree) + '.lock');
}

// readLockHolder(lockPath, F) -> {pid, ts} | null. A tolerant, READ-ONLY
// inspection of a lock file (never steals/removes it, unlike acquireIngestLock's
// own steal-rule). A genuinely MISSING file (ENOENT / unreadable) reads as "no
// holder" — fail-open, nothing was ever locked. An EXISTING but UNPARSEABLE file
// (including the torn-write window between a live holder's openSync('wx') and
// writeSync()) does NOT read as absent — it falls back to the file's own MTIME
// (`ts`, `pid:null`), mirroring acquireIngestLock's own torn-read guard
// (:150-155), so probeLegacyHolders below can tell a FRESH unparseable lock
// (probably a live holder mid-write) from a STALE one (probably an abandoned
// lock from a process that died before ever completing its write).
function readLockHolder(lockPath, F) {
  let raw;
  try { raw = F.readFileSync(lockPath, 'utf8'); } catch (_) { return null; } // ENOENT etc — genuinely no lock
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Number.isFinite(parsed.pid)) {
      return { pid: parsed.pid, ts: Number.isFinite(parsed.ts) ? parsed.ts : null };
    }
  } catch (_) {}
  let ts = null;
  try { ts = F.statSync(lockPath).mtimeMs; } catch (_) {}
  return { pid: null, ts };
}

// probeLegacyHolders(home, mainWorktree, io) -> { blocked, liveHolders } — D9
// REAP-BEFORE-DRAIN PROBE: enumerates this repo's worktrees via `git worktree
// list --porcelain` (installIngest.listRepoWorktrees; NEVER by inverting the
// one-way worktreeHash — Gap-2), checks EACH one's LEGACY per-worktree lock
// file, and reports whether ANY still has a LIVE (or presumed-live) holder
// (reusing the same isAlive discipline acquireIngestLock's steal-rule uses).
// `blocked:true` means the caller MUST NOT drain (never open the store, never
// call `monitor`) — two concurrent native-queue consumers would split it and
// silently lose messages.
//
// mainWorktree is ALWAYS included in the set checked, even when enumeration
// itself fails or omits it: `git worktree list --porcelain` is a SEPARATE git
// spawn from the one that resolved repoKey (the precondition for this probe
// running at all — see runIngestLoop), so it can fail transiently even when
// this repo's OWN worktree is perfectly resolvable. Without this floor, an
// enumeration failure would silently skip checking the single most common
// real-world case mid-migration — a legacy per-worktree daemon still running in
// THIS SAME worktree — and let the new daemon proceed to drain concurrently
// with it. A genuinely LINKED worktree's legacy holder remains a residual gap
// on enumeration failure (Gap-2: the hash cannot be inverted without
// enumerating) — unchanged, matches the pre-existing fail-open posture there.
//
// TORN-READ GUARD: an unparseable lock with a FRESH mtime (age <=
// INGEST_LOCK_STALE_MS) is presumed a live holder mid-write and blocks; only a
// STALE unparseable lock (or a genuinely missing one) reads as no holder.
//
// PID-REUSE GUARD (v0.65 — the highest-value half of this probe's hardening).
// The pre-0.65 rule was `alive = isAlive(holder.pid)` with NO identity check at
// all, unlike isHolderHeartbeatStale which has always verified the pid's OS
// start time. That asymmetry is an UNBOUNDED wedge: once a leaked legacy lock's
// recorded pid number is recycled to ANY unrelated live process (a shell, an
// editor, another agent session), this probe reports blocked:true forever and
// every restart of the project daemon refuses with "legacy per-worktree ingest
// holder(s) still alive" — the confirmed field failure this fix addresses.
// classifyLockHolder now applies the SAME start-time verification: a live pid
// whose start time postdates the lock's own ts cannot be the process that wrote
// it, so it is NOT a holder (and its lock is a proven orphan -> removed).
// A holder whose identity is CONFIRMED consistent with the lock still blocks
// exactly as before, and a FRESH lock (the shape a genuinely-looping legacy
// daemon always has, since its own loop refreshes the lock ts every iteration)
// still blocks even when the start time cannot be read.
//
// 'unconfirmed-stale' (alive per kill(pid,0), identity UNRESOLVABLE — e.g. a
// transient `ps`/`/proc` read failure — with the lock ts past the stale
// window) also BLOCKS, same as 'live'. This is an INCONCLUSIVE read, not a
// disproof: the pid could easily be the genuine, still-running legacy holder
// (the read failure is exactly as likely under process-table pressure — the
// runaway-node condition this daemon exists to survive — as it is under any
// other cause). Resolving that ambiguity toward "not blocking" would relax the
// ONLY guard preventing two concurrent `hivecontrol monitor` consumers on the
// same native queue; resolving it toward "blocking" costs nothing, since this
// state authorizes no removal either way (see isReclaimableHolderState — only
// 'dead'/'reused'/'zombie' ever unlink a lock). 'reused-fresh' blocks for the
// same reason and is likewise never removed: a live legacy daemon refreshes its
// own lock ts every iteration, so a postdated start time on a FRESH lock is
// clock-skew noise, not proof of pid reuse. Both fall out of the default-block
// rule in isBlockingHolderState rather than being listed here by hand.
function probeLegacyHolders(home, mainWorktree, io) {
  const F = (io && io.fs) || fs;
  const now = (io && io.now) || Date.now;
  // installIngest.listRepoWorktrees expects opts.io.run (matching its own
  // devswarm-repokey-style injection convention) — NOT opts.run directly.
  const enumerated = installIngest.listRepoWorktrees(mainWorktree, { io });
  const worktrees = (mainWorktree && !enumerated.includes(mainWorktree))
    ? enumerated.concat([mainWorktree])
    : enumerated;
  const liveHolders = [];
  const reaped = [];
  // Same real-time bound as sweepOrphanedIngestLocks' SWEEP_WALLCLOCK_DEADLINE_MS
  // (shared risk: classifyLockHolder's probes can each block up to ~5s on a
  // hung ps/proc read) — a pathologically large worktree enumeration must
  // never be able to stall daemon startup either.
  //
  // UNLIKE the sweep, this function's whole purpose is to GATE startup
  // (blocked:true means "do not drain") — silently skipping the remaining,
  // unprobed worktrees on a deadline and treating them as "not blocking"
  // would reintroduce the exact single-consumer risk this probe exists to
  // prevent (an unprobed worktree could easily hold a genuinely live legacy
  // daemon). So a deadline hit fails toward BLOCKING instead: every worktree
  // left unprobed is recorded as an unconfirmed live holder (no lock is ever
  // touched for it — reaping still requires an actual positive classify, only
  // reachable for worktrees probed before the deadline).
  const probeDeadlineAt = Date.now() + SWEEP_WALLCLOCK_DEADLINE_MS;
  for (let wi = 0; wi < worktrees.length; wi++) {
    const wt = worktrees[wi];
    if (Date.now() >= probeDeadlineAt) {
      // Deadline hit: still fail toward BLOCKING (see comment above), but do a
      // CHEAP existence-only check (stat, no isAlive/ps spawn) before adding
      // each remaining worktree to liveHolders — a worktree with no legacy
      // lock file at all cannot possibly hold anything, so it should not
      // manufacture a phantom blocker. Any error resolving the path or
      // stat'ing it (including a mock `F` without statSync) falls back to the
      // prior fail-toward-blocking behavior — this only ever makes the
      // deadline-exceeded case LESS blocking, never more.
      for (let rest = wi; rest < worktrees.length; rest++) {
        const wtRest = worktrees[rest];
        let lockPathRest = null;
        let hasLock = true;
        try {
          lockPathRest = legacyIngestLockPath(home, wtRest);
          F.statSync(lockPathRest);
        } catch (e) {
          hasLock = e && e.code === 'ENOENT' ? false : true;
        }
        if (hasLock) liveHolders.push({ worktree: wtRest, lockPath: lockPathRest, pid: null, reason: 'probe-deadline-exceeded' });
      }
      break;
    }
    let lockPath;
    try { lockPath = legacyIngestLockPath(home, wt); } catch (_) { continue; } // fail-open: one bad path never aborts the probe
    const holder = readLockHolder(lockPath, F);
    if (!holder) continue;
    let cls;
    try { cls = classifyLockHolder(holder, now(), io); } catch (_) { cls = { state: 'live', pid: holder.pid, ts: holder.ts }; }
    // DEFAULT-BLOCK: everything that is not positively proven gone (and not an
    // empty/abandoned record) counts as a holder — see isBlockingHolderState.
    if (isBlockingHolderState(cls.state)) {
      liveHolders.push({ worktree: wt, lockPath, pid: holder.pid });
      continue;
    }
    // PROVEN-ORPHAN removal only (dead / recycled-pid / defunct). A merely
    // stale or unconfirmable record is left on disk untouched — it just no
    // longer blocks. Per-file and idempotent: an already-gone file is a no-op.
    if (isReclaimableHolderState(cls.state)) {
      // TOCTOU GUARD: `cls` proved the holder read at `holder` (above) is dead
      // — but that proof is only valid for THAT exact record. A concurrent
      // daemon can remove this same-path lock and write a fresh LIVE one in
      // the window between the read above and this unlink; re-read the file
      // right before removing it and require it to be byte-identical (same
      // pid, same ts) to what was classified. Any mismatch means someone else
      // already touched this path — leave it alone (it is either already gone
      // or a brand-new live holder, never ours to remove).
      try {
        const current = readLockHolder(lockPath, F);
        if (current && current.pid === holder.pid && current.ts === holder.ts) {
          F.unlinkSync(lockPath);
          reaped.push({ worktree: wt, lockPath, pid: holder.pid, reason: cls.state });
        }
      } catch (_) { /* already removed / unwritable -> nothing to do */ }
    }
  }
  if (reaped.length) {
    alog.logEvent('lock', 'reap-legacy-ingest-lock', 'warn',
      'removed ' + reaped.length + ' legacy per-worktree ingest lock(s) whose recorded holder is provably not running',
      { reaped });
  }
  return { blocked: liveHolders.length > 0, liveHolders, reaped };
}

// ingestLocksDir(home) — the ONE directory every ingest lock shape lives in.
function ingestLocksDir(home) { return path.join(devswarmRoot(home), 'locks'); }

// INGEST_LOCK_NAME_RE — the three lock shapes this daemon family owns:
// `ingest.lock` (legacy global), `ingest-<worktreeHash>.lock` (legacy
// per-worktree) and `ingest-project-<repoKey>.lock` (v0.57 per-project). Anchored
// and `.lock`-terminated so the sweep can NEVER touch a neighbouring lock owned
// by something else (`migrate.lock`, the store's own locks) or the transient
// `<lock>.hb.<pid>` rename-staging files (which do not end in `.lock`).
const INGEST_LOCK_NAME_RE = /^ingest(-[A-Za-z0-9._-]+)?\.lock$/;
// Bound on one sweep so a pathological directory can never stall daemon startup.
const INGEST_LOCK_SWEEP_MAX_FILES = 500;
// SWEEP_WALLCLOCK_DEADLINE_MS — a SEPARATE, real-time bound alongside the
// file-count cap above. Each classify (isAlive/startTimeOf/isZombie) can spawn
// a real `ps`/read `/proc`, each with its OWN up-to-5s timeout (see
// defaultProcessStartTimeMs / defaultIsZombieProcess) — with ~500 live-
// consistent locks needing BOTH probes serially, the file-count cap alone
// still allows a worst case of ~500 * 2 * 5s = ~5000s, effectively hanging
// daemon startup under load (verified: exactly 500 serial per-probe calls).
// This deadline is checked once per file using the REAL clock (Date.now(),
// never the injectable `io.now` used for staleness math elsewhere in this
// file — a test-mocked/frozen clock must never silently disable a wall-clock
// safety bound) and degrades gracefully: remaining files are simply left
// unscanned this round (kept, untouched) rather than aborting the sweep or
// daemon startup. The sweep re-runs every daemon start, so anything skipped
// here is picked up next time — fail-open, never a hard failure.
const SWEEP_WALLCLOCK_DEADLINE_MS = 10000;

// sweepOrphanedIngestLocks(home, io, skipPath) -> { scanned, kept, reaped[] }.
// v0.65 ORPHANED-LOCK SWEEP, run ONCE at daemon start (before the first drain).
//
// WHY: acquireIngestLock only ever inspects the ONE lock this daemon contends
// for. Every OTHER ingest lock — other projects, retired worktrees, shapes from
// older releases — is never revisited by anything, so leaked records accumulate
// without bound (observed in the field: 58 files, 52 of them owned by pids that
// no longer existed). Each of those is a latent permanent refusal the moment its
// recorded pid number is recycled.
//
// SAFETY, in order of importance:
//   * `skipPath` (the lock this daemon holds / is about to take) is NEVER
//     considered, whatever its contents say.
//   * A file is removed ONLY on a CONFIRMED-orphan verdict from
//     classifyLockHolder (dead pid / proven pid-reuse / confirmed zombie), or on
//     a torn-unparseable record whose own mtime is past the stale window (the
//     pre-existing "abandoned mid-write" reading probeLegacyHolders has always
//     used). Anything live, fresh, or merely unconfirmable is KEPT.
//   * Removal is per-file, wrapped, and idempotent — there is no directory-level
//     delete anywhere in this function.
//   * NOTHING here signals a process. Ever.
// Fully fail-open: a missing locks dir, an unreadable entry, or any thrown error
// yields a partial result instead of touching daemon startup.
function sweepOrphanedIngestLocks(home, io, skipPath, opts) {
  const F = (io && io.fs) || fs;
  const now = (io && io.now) || Date.now;
  // allowTornStale: a zero-byte/torn lock has NO pid to positively confirm
  // dead/reused/zombie against — its only evidence is file age. Left OFF by
  // default so the AUTOMATIC per-daemon-start sweep (runIngestLoop's call
  // below, which never passes opts) can never evict a suspended-then-resumed
  // holder's own torn-write lock purely by age. Only the EXPLICIT, human-
  // invoked `doctor --reclaim-ingest-lock` path (see doctor-repair.js) opts
  // in — matching this feature's existing "explicit operator action only"
  // posture for anything without proven holder identity.
  const allowTornStale = !!(opts && opts.allowTornStale);
  const result = { scanned: 0, kept: 0, reaped: [] };
  let dir;
  try { dir = ingestLocksDir(home); } catch (_) { return result; }
  let names;
  try { names = F.readdirSync(dir); } catch (_) { return result; } // no locks dir yet -> nothing to sweep
  let skipReal = null;
  try { skipReal = skipPath ? path.resolve(skipPath) : null; } catch (_) { skipReal = null; }
  const sweepDeadlineAt = Date.now() + SWEEP_WALLCLOCK_DEADLINE_MS;
  for (const name of (names || [])) {
    if (result.scanned >= INGEST_LOCK_SWEEP_MAX_FILES) break;
    if (Date.now() >= sweepDeadlineAt) break; // real-time bound — see SWEEP_WALLCLOCK_DEADLINE_MS
    if (!INGEST_LOCK_NAME_RE.test(String(name))) continue;
    const full = path.join(dir, String(name));
    // NEVER the lock this daemon is about to take / already holds.
    if (skipReal !== null && path.resolve(full) === skipReal) continue;
    result.scanned++;
    try {
      const holder = readLockHolder(full, F);
      if (!holder) continue; // vanished between readdir and read -> nothing to reap
      // Inode captured AT CLASSIFY TIME (best-effort; unresolvable -> null,
      // never blocks the sweep) — an extra identity check alongside pid/ts at
      // unlink time below, narrowing the TOCTOU window further.
      let inoAtClassify = null;
      try { inoAtClassify = F.statSync(full).ino; } catch (_) { inoAtClassify = null; }
      const cls = classifyLockHolder(holder, now(), io);
      const sweepable = isReclaimableHolderState(cls.state) || (allowTornStale && cls.state === 'torn-stale');
      if (!sweepable) { result.kept++; continue; }
      // TOCTOU GUARD (same as probeLegacyHolders): re-read the file immediately
      // before removing it and require it to still match the exact record that
      // was classified (pid + ts), AND — when resolvable — the same inode as
      // at classify time. If a concurrent daemon has already removed this
      // holder and written a fresh lock at the same path in the interim, a
      // content or inode mismatch skips the unlink rather than risk deleting
      // the new holder's lock out from under it.
      try {
        const current = readLockHolder(full, F);
        let sameInode = true;
        if (inoAtClassify != null) {
          try { sameInode = F.statSync(full).ino === inoAtClassify; } catch (_) { sameInode = false; }
        }
        if (sameInode && current && current.pid === holder.pid && current.ts === holder.ts) {
          F.unlinkSync(full);
          result.reaped.push({ lockPath: full, pid: cls.pid, reason: cls.state });
        }
      } catch (_) { /* already gone / unwritable -> idempotent no-op */ }
    } catch (_) { /* one malformed lock never aborts the sweep */ }
  }
  if (result.reaped.length) {
    alog.logEvent('lock', 'sweep-orphaned-ingest-locks', 'warn',
      'reaped ' + result.reaped.length + ' orphaned ingest lock file(s) at daemon start',
      { dir, scanned: result.scanned, kept: result.kept, reaped: result.reaped });
  }
  return result;
}

// writeIngestHeartbeat — atomic (tmp+rename) per-worktree daemon liveness file. Fully
// fail-open: any error (bad hash, unwritable dir) is swallowed so a heartbeat failure
// can never crash the ingest loop.
function writeIngestHeartbeat(home, hash, meta, fsi) {
  if (hash == null || hash === '') return;
  const F = fsi || fs;
  try {
    const p = ingestHeartbeatPath(home, hash);
    F.mkdirSync(path.dirname(p), { recursive: true });
    const m = meta || {};
    const beat = {
      ts: Number.isFinite(m.now) ? m.now : Date.now(),
      workspaceId: m.workspaceId != null ? String(m.workspaceId) : null,
      workingDir: m.workingDir != null ? String(m.workingDir) : null,
      pid: process.pid,
      // MONITOR-OUTCOME FIELDS (v0.66). The heartbeat used to record LIVENESS
      // ONLY, written unconditionally BEFORE each monitor call — so a daemon
      // whose every monitor call failed still looked perfectly RUNNING to
      // doctor. These make "alive but ingesting nothing" detectable from this
      // file alone (no jsonl parsing). ABSENT on a pre-v0.66 daemon's heartbeat:
      // every consumer MUST treat missing as UNKNOWN, never as failure.
      lastMonitorOkMs: Number.isFinite(m.lastMonitorOkMs) ? m.lastMonitorOkMs : null,
      consecutiveMonitorFailures: Number.isFinite(m.consecutiveMonitorFailures) ? m.consecutiveMonitorFailures : 0,
      lastMonitorErrorCode: m.lastMonitorErrorCode != null ? String(m.lastMonitorErrorCode) : null,
      lastMonitorError: m.lastMonitorError != null ? String(m.lastMonitorError).slice(0, 300) : null,
      hivecontrolBin: m.hivecontrolBin != null ? String(m.hivecontrolBin) : null,
      hivecontrolSource: m.hivecontrolSource != null ? String(m.hivecontrolSource) : null,
      // The daemon's OWN inherited PATH — the single most useful datum when the
      // fault is "the scheduler gave this unit a PATH without the CLI in it".
      // Bounded so a pathological PATH can never bloat the heartbeat file.
      daemonPath: m.daemonPath != null ? String(m.daemonPath).slice(0, 1024) : null,
      // codeVersion/startedAtMs (stale-running detection): ABSENT on a
      // pre-this-fix daemon's heartbeat — every consumer MUST treat a missing
      // codeVersion as "older than any real semver", never as "current" or
      // "unknown-so-skip" (see readInstalledPluginVersion above).
      codeVersion: m.codeVersion != null ? String(m.codeVersion) : null,
      startedAtMs: Number.isFinite(m.startedAtMs) ? m.startedAtMs : null,
    };
    const tmp = p + '.' + process.pid + '.tmp';
    F.writeFileSync(tmp, JSON.stringify(beat));
    F.renameSync(tmp, p);
  } catch (_) { /* fail-open: liveness heartbeat is best-effort */ }
}

function main() {
  // A real invocation runs unbounded until killed (launchd/systemd re-execs it on
  // exit). workspaceId is the ingesting workspace's own id (DEVSWARM_BUILDER_ID),
  // defaulting to 'primary' outside a workspace.
  let summary;
  try {
    summary = runIngestLoop({ env: process.env });
  } catch (_e) {
    // runIngestLoop already appended a timestamped ERROR+stack line to the log
    // (fail-open, BEFORE this rethrow) — this catch only turns it into a clean,
    // controlled non-zero exit instead of falling through to Node's default
    // uncaught-exception dump (which launchd/systemd/cron may or may not capture
    // depending on platform).
    process.exit(1);
    return;
  }
  if (!summary.started) {
    // The lock-refusal case already appended its own log line inside
    // runIngestLoop (see the `!release` branch above) before returning here.
    fs.writeSync(2, JSON.stringify(summary) + '\n');
    process.exit(1);
    return;
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  ingestLockPath, ingestHeartbeatPath, acquireIngestLock,
  messageHash, stableJson, normalizeMonitorPayload,
  ingestPayload, defaultMonitorRun, runIngestLoop,
  // v0.66 — B1 destructive-read loss detection + quarantine:
  rawIsSubstantive, quarantineDir, quarantineLossyMonitorBatch,
  quarantineCapacityReached, QUARANTINE_MAX_FILES, QUARANTINE_MAX_BODY_BYTES,
  DEFAULT_MONITOR_TIMEOUT_SEC, resolveMonitorTimeoutSec,
  logFilePath, appendLog,
  // v0.57 mesh (D9/D21) — reap-before-drain probe:
  legacyIngestLockPath, readLockHolder, probeLegacyHolders,
  // v0.65 daemon-reliability — holder classification + orphaned-lock sweep:
  classifyLockHolder, sweepOrphanedIngestLocks, ingestLocksDir,
  isReclaimableHolderState, isBlockingHolderState, RECLAIMABLE_HOLDER_STATES,
  defaultIsZombieProcess, defaultProcessStartTimeMs,
  INGEST_LOCK_STALE_MS, PID_REUSE_TOLERANCE_MS, INGEST_LOCK_NAME_RE,
  // v0.66 — hivecontrol resolution + monitor-failure circuit breaker:
  HIVECONTROL_ENV_VAR, DEFAULT_HIVECONTROL_BIN,
  resolveHivecontrolBin, hivecontrolBinUsable,
  monitorFailureCode, permanentBackoffMs, createMonitorBreaker,
  writeIngestHeartbeat,
  PERMANENT_SPAWN_ERROR_CODES, PERMANENT_BACKOFF_CAP_MS, PERMANENT_BACKOFF_STEPS,
  // stale-running detection (pacing-fix delivery gap):
  readInstalledPluginVersion,
};
