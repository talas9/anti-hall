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

const INGEST_LOCK_STALE_MS = 15 * 60 * 1000; // a monitor consumer is long-lived; only a truly dead/old holder is stolen
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

// acquireIngestLock(home, io) -> release() | null. null => another monitor
// consumer holds the lock; the daemon MUST refuse to start (single-consumer
// invariant). The returned release() carries a `.heartbeat()` the live daemon
// calls each loop to REFRESH its own lock timestamp, so a healthy long-lived
// consumer is never seen as stale (and thus never stolen).
//
// STEAL RULE (data-loss guard): a lock is stolen ONLY when it is BOTH stale AND
// not held by a live process — i.e. the holder is DEAD or UNKNOWN. A KNOWN-LIVE
// holder is NEVER stolen even if its timestamp looks old, because stealing from a
// live `hivecontrol workspace monitor` consumer would split the destructive
// native queue between two daemons and silently lose messages. Requiring BOTH
// conditions (never one alone) is the fix for the "stale-steals-a-live-daemon" bug.
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
      const alive = holderPid !== null && isAlive(holderPid); // a KNOWN-live holder
      const stale = holderTs === null || (now() - holderTs) > INGEST_LOCK_STALE_MS;
      // Steal ONLY a stale lock whose holder is NOT alive (dead or unknown pid).
      // Never steal from a live holder, however old its timestamp looks.
      if (stale && !alive) { try { F.unlinkSync(p); } catch (_) {} continue; }
      return null; // live holder, or a fresh lock -> refuse
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

// normalizeMonitorPayload(raw) -> message object[]. hivecontrol emits JSON by
// default (no --json flag). The exact monitor batch SHAPE is not pinned in the
// KB, so parse tolerantly: accept a JSON string OR an already-parsed value, and
// unwrap the plausible shapes — an array, `{ messages: [...] }`, `{ data: [...] }`,
// or a single message object. Anything unparseable -> [] (fail-soft; a bad batch
// never crashes the loop).
function normalizeMonitorPayload(raw) {
  let val = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return [];
    try { val = JSON.parse(t); } catch (_) { return []; }
  }
  if (Array.isArray(val)) return val.filter((x) => x && typeof x === 'object');
  if (val && typeof val === 'object') {
    if (Array.isArray(val.messages)) return val.messages.filter((x) => x && typeof x === 'object');
    if (Array.isArray(val.data)) return val.data.filter((x) => x && typeof x === 'object');
    // A single message object (has any of the known message fields).
    if ('message' in val || 'fromBranch' in val || 'toBranch' in val) return [val];
  }
  return [];
}

// ingestPayload(s, raw, opts) -> { total, inserted, duplicate }. Normalizes a
// monitor batch and appends each message to the store keyed by the ingesting
// workspace id, deduped by content hash. Re-ingesting the same batch inserts 0
// (replay idempotence).
function ingestPayload(s, raw, opts) {
  const o = opts || {};
  const workspaceId = String(o.workspaceId);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const messages = normalizeMonitorPayload(raw);
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
  return { total: messages.length, inserted, duplicate };
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
    if (r.error) return { ok: false, raw: '', error: String(r.error.message || r.error) };
    return { ok: true, raw: String(r.stdout || ''), error: null };
  } catch (e) {
    return { ok: false, raw: '', error: String(e && e.message || e) };
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

  const logFs = o.io && o.io.logFs;
  const release = (o.io && o.io.lock) ? o.io.lock(home) : acquireIngestLock(home, o.io, worktree);
  if (!release) {
    const reason = 'another monitor consumer is already running (ingest lock held)';
    appendLog(home, 'ingest daemon refused to start: ' + reason, logFs);
    return { ok: false, started: false, reason };
  }
  // SIGNAL-SAFE RELEASE (P0 fix): a normal return/throw already releases the lock
  // via the `finally` below, but that's ordinary JS control flow — an OS signal
  // (SIGTERM from launchd stopping/restarting this unit, Ctrl-C, `kill <pid>`)
  // bypasses it entirely (Node's default SIGTERM/SIGINT disposition is immediate
  // termination; no finally runs), leaking the lock and forcing every other starter
  // to wait out the full INGEST_LOCK_STALE_MS window before recovery. SIGTERM/SIGINT
  // ARE trappable (SIGKILL/a hard OOM-kill genuinely is not — those still rely on
  // the stale+dead reclaim path in acquireIngestLock, unchanged here), so trap them
  // and release before exiting. `proc` is injectable via io.process (same DI seam as
  // io.fs/io.isAlive/io.now/io.lock above) so tests can capture + invoke the handler
  // deterministically instead of sending a real OS signal to the test worker.
  const proc = (o.io && o.io.process) || process;
  const onSignal = function onSignal() {
    try { release(); } catch (_) {}
    proc.exit(0);
  };
  proc.on('SIGTERM', onSignal);
  proc.on('SIGINT', onSignal);

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
  const stats = { iterations: 0, inserted: 0, duplicate: 0, errors: 0 };
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
    appendLog(home, 'ingest daemon started, worktree=' + (worktree || '(unresolved)') + ', workspaceId=' + workspaceId, logFs);

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
      writeIngestHeartbeat(home, hbHash, { workspaceId, workingDir: worktree, now: o.now }, (o.io && o.io.storeFs));
      const res = run({
        hivecontrol: o.hivecontrol, intervalSec,
        timeoutSec, hardTimeoutMs,
      });
      stats.iterations++;
      if (!res.ok) {
        stats.errors++;
        if (i + 1 < maxIterations) sleep(backoffMs); // crash -> backoff then re-spawn
        continue;
      }
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
          if (i + 1 < maxIterations) sleep(backoffMs);
          continue;
        }
        throw e;
      }
      stats.inserted += ing.inserted;
      stats.duplicate += ing.duplicate;
      if (ing.inserted > 0) store.deriveSummary(s, { home, env: o.env, now: o.now });
    }
  } catch (e) {
    // Startup (store-open) AND main-loop failures land here. Fail-open: APPEND a
    // timestamped ERROR+stack line BEFORE this rethrows — today a startup failure
    // exits silently, leaving nothing to diagnose. appendLog is itself fully
    // try/catch-wrapped and can never mask this rethrow.
    appendLog(home, 'ERROR: ' + (e && e.message ? e.message : String(e)) + (e && e.stack ? ('\n' + e.stack) : ''), logFs);
    throw e;
  } finally {
    try { if (s) s.close(); } catch (_) {}
    try { release(); } catch (_) {}
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
function probeLegacyHolders(home, mainWorktree, io) {
  const F = (io && io.fs) || fs;
  const isAlive = (io && io.isAlive) || isAliveDefault;
  const now = (io && io.now) || Date.now;
  // installIngest.listRepoWorktrees expects opts.io.run (matching its own
  // devswarm-repokey-style injection convention) — NOT opts.run directly.
  const enumerated = installIngest.listRepoWorktrees(mainWorktree, { io });
  const worktrees = (mainWorktree && !enumerated.includes(mainWorktree))
    ? enumerated.concat([mainWorktree])
    : enumerated;
  const liveHolders = [];
  for (const wt of worktrees) {
    const lockPath = legacyIngestLockPath(home, wt);
    const holder = readLockHolder(lockPath, F);
    if (!holder) continue;
    const alive = holder.pid !== null && isAlive(holder.pid);
    const freshUnparseable = holder.pid === null
      && holder.ts !== null && (now() - holder.ts) <= INGEST_LOCK_STALE_MS;
    if (alive || freshUnparseable) liveHolders.push({ worktree: wt, lockPath, pid: holder.pid });
  }
  return { blocked: liveHolders.length > 0, liveHolders };
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
    const beat = {
      ts: Number.isFinite(meta && meta.now) ? meta.now : Date.now(),
      workspaceId: meta && meta.workspaceId != null ? String(meta.workspaceId) : null,
      workingDir: meta && meta.workingDir != null ? String(meta.workingDir) : null,
      pid: process.pid,
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
  DEFAULT_MONITOR_TIMEOUT_SEC, resolveMonitorTimeoutSec,
  logFilePath, appendLog,
  // v0.57 mesh (D9/D21) — reap-before-drain probe:
  legacyIngestLockPath, readLockHolder, probeLegacyHolders,
};
