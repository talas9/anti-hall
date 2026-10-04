'use strict';
// anti-hall :: devswarm CLI — CORE module (scripts/devswarm-lib/core.js).
// Stage 2 of the devswarm.js split: a PURE MOVE of the shared requires, path /
// lock helpers, appendIntoPartition, parseArgs, buildDescriptorFromFlags, the
// immutable constants and the module-level state they own out of
// scripts/devswarm.js (the CLI dispatcher). No behaviour change. This module
// must NEVER require devswarm.js (dependency-closed: it only needs the
// companion/hooks libs). It is one level deeper than the dispatcher, so every
// relative require here is `../../…`; CLI_PATH / PLUGIN_ROOT name the
// dispatcher script and plugin root for code that used to read its own
// __filename/__dirname.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const store = require('../../companion/lib/devswarm-store.js');
const livenessSelect = require('../../companion/lib/devswarm-liveness-select.js');
const inboxCursor = require('../../companion/lib/devswarm-inbox-cursor.js');
const devswarmUnread = require('../../companion/lib/devswarm-unread.js');
// Phase 3: ONE read-position model (reader_cursors table) + ONE reader identity.
const readerCursors = require('../../companion/lib/reader-cursors.js');
const readerIdentity = require('../../companion/lib/reader-identity.js');
// Phase 4: THE one row-state derivation (archived / app-archived / active /
// unknown). Every read-side "is this row archived?" question goes through it.
const rowStateLib = require('../../companion/lib/row-state.js');
// row-eligibility.js: THE one per-row projection over every archive source
// (plus held / archive-ignore / liveness). Row-level "is this archived?"
// questions (routing, roster, diagnose) read its `archived`.
const rowEligibilityLib = require('../../companion/lib/row-eligibility.js');
// cliRowLog(event, details, id): the alog sink every eligibility context in
// this file shares (row-state's superseded-marker event, tagged with the row).
function cliRowLog(event, details, id) {
  try { alog.logEvent('devswarm-cli', event, 'info', Object.assign({ row: id }, details || {})); } catch (_) {}
}
// SHARED archive-resurrection gate (defect df54edf54804 item 4) — the same
// bulk-reregistration decision companion/devswarm-migrate.js's one-time store
// migration uses, reused here by healOrphanPartitions so a worktree-group
// sibling the migration correctly refuses to resurrect is not silently
// re-adopted by the doctor repair pass instead. See that module's header.
const archiveGateLib = require('../../companion/lib/devswarm-archive-gate.js');
// APP-SIDE archive cache (read side; the WRITE side is the supervisor sweep,
// fed by fetchActiveWorkspaceRecords below). Leaf module — no cycle.
const archivedCacheLib = require('../../companion/lib/devswarm-archived-cache.js');
const {
  isSafeId, devswarmRoot, livenessPathFor,
  writeVerdict, hasFreshHeartbeat, heartbeatTs, worktreeActivityMtime, unreadBacklog, DEFAULT_IDLE_MS,
  // DEFAULT_HEARTBEAT_FRESH_MS — the SAME liveness window `hasFreshHeartbeat`
  // uses, reused (not re-implemented) by rosterHints'/computeDiagnosis'
  // instance-nonce-split scan below (defect d3d571495bf6, roster/diagnose
  // consumers) so "recent enough to count as a live instance" means the same
  // thing everywhere in this file.
  DEFAULT_HEARTBEAT_FRESH_MS,
  isDormantRow, unionPendingFor, isSiblingPartitionLive, rowLivenessState,
  // heartbeatPathFor — the `unclaimed:` forward migration's ONLY independent
  // source of a row's real session id (cmdHeartbeat records `--session`).
  heartbeatPathFor,
  // sessionsDirFor — the harness's own `<home>/.claude/sessions/<pid>.json`
  // directory (defect 54a6539e2d69's parent-pid-chain fallback derivation).
  // pidIsAlive — the SAME pid-reuse/start-time staleness guard
  // sessionPidAlive already applies, reused (not re-implemented) for the
  // session file the parent-pid-chain walk finds (R22 P2).
  sessionsDirFor, pidIsAlive,
  // processStartMs — reused (not re-implemented) by deriveInstanceNonce below
  // (defect d3d571495bf6) for its own-process fallback nonce.
  processStartMs,
  // isSessionAliveRow — POSITIVE pid-alive proof only (never satisfied by a
  // fresh heartbeat alone, unlike isSiblingPartitionLive's branch 1). Reused
  // by cmdRegisterPrimary's live-conflict refusal (defect 7d0a948031cd, C):
  // that refusal must require actual proof the CONFLICTING session's harness
  // process is running, not merely that ITS row heartbeated recently.
  isSessionAliveRow,
} = require('../../companion/lib/liveness.js');
// devswarmIdle.childBusyState — the ONE waiting-on-human detector (peer B:
// roster row hint + the parent gate's own hard-block line already reuse it,
// never a second implementation of "is a transcript paused on an unresolved
// AskUserQuestion/ExitPlanMode").
const devswarmIdle = require('../../companion/lib/devswarm-idle.js');
const { readDescriptors } = require('../../companion/devswarm-supervisor.js');
const { pokeOrEscalate, acquireLock } = require('../../companion/lib/recovery.js');
const migrate = require('../../companion/devswarm-migrate.js');
const pull = require('../../companion/lib/devswarm-pull.js');
// v0.108.0 — every hivecontrol call below goes through the capability gate
// (companion/lib/devswarm-capabilities.js): a verb this DevSwarm build lacks is
// refused without spawning; an absent binary passes through unchanged. Lazy on
// pull.defaultRun so a test that swaps that export is still honoured.
const devswarmCaps = require('../../companion/lib/devswarm-capabilities.js');
function hcRun(spec) { return devswarmCaps.gatedRun(pull.defaultRun)(spec); }
const inst = require('../../companion/install-devswarm-ingest.js');
const repokey = require('../../companion/lib/devswarm-repokey.js');
const identity = require('../../companion/lib/identity.js');
// identityContext(p) — identity.resolveContext for this module. memo:false because
// long-lived processes (the supervisor) require this file and a cached non-git
// answer must never go stale; superCache keeps the one nested-repo git answer
// (5-min TTL), so a sweep pays at most one spawn per nested `.git` DIR root.
// Registry/descriptor paths use the default missingPath 'null' (a deleted path is
// unknown, never folded onto an enclosing repo); a CALLER's own cwd passes
// CALLER_CWD (a deleted cwd resolves from its nearest existing ancestor).
const CALLER_CWD = { missingPath: 'ancestor' };
function identityContext(p, extra) { return identity.resolveContext(p, Object.assign({ memo: false, superCache: true }, extra)); }

// runningAntiHallVersion() -> semver string | null. Item 4a (P0, field-proven):
// a child auto-resumed BEFORE the harness re-registered a newer build keeps
// running the OLD code with no signal anywhere that it is stale — 0.105.3
// (NDJSON-only) cannot see store-side mesh mail, so the Primary saw it as
// "not draining" when the real cause was a stale build. Stamping the CALLING
// process's own version onto every heartbeat/tick record (see cmdHeartbeat /
// cmdInboxTick below) lets a reader (roster/parent-inbox/doctor, item 4b) tell
// "stale build" apart from "genuinely wedged" instead of guessing. Resolved
// via __dirname (this file's OWN on-disk location), same pattern as
// devswarm-wake-watch.js's readInstalledPluginVersion / devswarm-ingest.js's
// helper of the same name — always names the build actually loaded into THIS
// process, never a machine-wide "latest" (that comparison happens on the READ
// side). Cached (computed once per process — this file's own location cannot
// change mid-process) and fail-open to null (never throws, never blocks a
// heartbeat/tick write).
let _runningAntiHallVersionCache;
function runningAntiHallVersion() {
  if (_runningAntiHallVersionCache !== undefined) return _runningAntiHallVersionCache;
  let v = null;
  try {
    const p = path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json');
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    v = (json && typeof json.version === 'string') ? json.version : null;
  } catch (_) { v = null; }
  _runningAntiHallVersionCache = v;
  return v;
}
const ingestHealth = require('../../companion/lib/ingest-health.js');
const { isDevswarmActive } = require('../../hooks/lib/devswarm-detect.js');
const { isForwardableRow } = require('../../companion/lib/devswarm-noise.js');
const names = require('../../companion/lib/devswarm-names.js');
// Meeseeks supervision (plan tracking + straying): the per-workspace step plan.
const planLib = require('../../companion/lib/devswarm-plan.js');
const supervisionMetrics = require('../../companion/lib/devswarm-supervision-metrics.js');
const gitTruth = require('../../companion/lib/devswarm-git-truth.js');
// wakeLib/isChildWorkspace: `wake-directive <id>` (C, trimmed Stop-gate
// reassert follow-up) reuses the SAME wakeDirective() text
// hooks/devswarm-child-role.js emits at SessionStart and the SAME role
// signal (DEVSWARM_SOURCE_BRANCH) hooks/lib/devswarm-role.js uses — never a
// reimplementation, so the two can never drift.
const wakeLib = require('../../hooks/lib/devswarm-wake.js');
const { isChildWorkspace, isChildWorkspaceCorroborated } = require('../../hooks/lib/devswarm-role.js');
const stableLauncherLib = require('../../hooks/lib/stable-launcher.js');

// resolveStableCliPath(home, fallback) -> the version-independent
// ~/.anti-hall/bin/devswarm.js launcher path when it EXISTS on disk, else
// `fallback` (normally this file's own __filename). Defect (a DevSwarm Primary
// field report, 2026-09-27): `inbox read-primary`'s returned `ackCommand`
// always embedded THIS invocation's own __filename — the version-pinned
// plugin-cache path (…/cache/anti-hall/anti-hall/<ver>/scripts/devswarm.js)
// — which a caller may run in a LATER turn/session, by which point an
// anti-hall update can have pruned that exact version directory. Every
// injected-directive-text caller elsewhere (hooks/devswarm-child-role.js,
// devswarm-parent-gate.js, devswarm-child-gate.js, devswarm-child-drain.js)
// already solves this the same way: prefer the stable launcher
// hooks/lib/stable-launcher.js installs under ~/.anti-hall/bin/, which
// re-resolves the CURRENTLY REGISTERED anti-hall version every time IT runs.
// Unlike those hooks (which actively install/refresh the launcher at
// SessionStart/Stop), this is a plain CLI read path — it only CHECKS whether
// the launcher already exists (never installs it itself) and falls back to
// `fallback` otherwise, so a fresh install with no hook having run yet still
// gets a directly-runnable command. Fail-open: any resolution error also
// falls back to `fallback`.
function resolveStableLauncherPath(kind, home, fallback) {
  try {
    const p = stableLauncherLib.launcherPath(kind, home);
    if (p && fs.statSync(p).isFile()) return p;
  } catch (_) { /* fall through to fallback */ }
  return fallback;
}
function resolveStableCliPath(home, fallback) {
  return resolveStableLauncherPath('devswarm', home, fallback);
}

// warnIdMismatch(id, ctx) -> boolean (idMismatch). defect 735b179362e8: a
// child substituted its OWN meshId (or some other id) into the `<id>` slot
// of a heartbeat/tick command instead of the real DEVSWARM_BUILDER_ID the
// wake/turn instructions actually meant — silently addressing the wrong
// mesh partition (the row is written/read under the wrong id, so the
// intended recipient/observer never sees it). Fail-OPEN by design (never
// refuse the call over this — a caller may have a legitimate reason to
// heartbeat a DIFFERENT id, e.g. an operator managing a sibling): only when
// this IS a CORROBORATED child workspace AND env.DEVSWARM_BUILDER_ID is
// set/safe AND differs from the argv `id` does this print ONE stderr warning
// naming both ids and return true, so the caller can fold `idMismatch:true`
// into its JSON result for a downstream reader/log to notice, without ever
// blocking the command itself.
//
// Wave 3 addendum item 8 (P2 fix): gated on `isChildWorkspaceCorroborated`
// (hooks/lib/devswarm-role.js — the SAME on-disk-evidence-required signal
// hooks/devswarm-child-gate.js and hooks/devswarm-parent-gate.js already
// require before trusting DEVSWARM_SOURCE_BRANCH), not the bare, uncorroborated
// `isChildWorkspace`. `isChildWorkspace` alone trusts DEVSWARM_SOURCE_BRANCH
// with NO on-disk proof — a Primary session that merely inherited a leaked
// DEVSWARM_SOURCE_BRANCH env var (e.g. from a parent shell) would get told
// "you're addressing the wrong id, use env.DEVSWARM_BUILDER_ID instead" even
// though it is not a child at all and that advice is nonsense for it.
function warnIdMismatch(id, ctx) {
  try {
    const env = ctx && ctx.env;
    const home = ctx && ctx.home;
    const cwd = ctx && ctx.cwd;
    if (!isChildWorkspaceCorroborated(env, home, cwd)) return false;
    const envId = env && env.DEVSWARM_BUILDER_ID;
    if (!isSafeId(envId)) return false;
    if (!isSafeId(id)) return false;
    if (String(id) === String(envId)) return false;
    process.stderr.write('⚠️ anti-hall · devswarm: addressing id ' + JSON.stringify(String(id))
      + ' but this workspace\'s real DEVSWARM_BUILDER_ID is ' + JSON.stringify(String(envId))
      + ' — addressing the meshId row counts the wrong partition; use ' + JSON.stringify(String(envId))
      + ' unless you deliberately mean a different workspace\n');
    return true;
  } catch (_) {
    return false; // fail-open: a broken check must never affect the call it warns about
  }
}
// Shared structured JSONL logger (C0). Console fallback so a missing/older
// companion never breaks the CLI — logging is strictly additive and fail-open;
// alog.logError NEVER throws into a caller and NEVER changes control flow.
let alog;
try { alog = require('../../companion/lib/anti-hall-log'); }
catch (_) { alog = { logError() { try { console.error.apply(console, arguments); } catch (_e) {} }, logEvent() {} }; }

// ---------------------------------------------------------------------------
// Per-id advisory lock (P1-4/P1-5/P1-1/P1-2). REUSES recovery.js's acquireLock
// (atomic O_EXCL create of locks/<id>.lock carrying {pid,ts,token}, dead/stale-
// holder steal, release unlinks ONLY when the on-disk token is still ours) so a
// descriptor+registry mutation (register / archive / unarchive / reap / re-home)
// for ONE workspace id is never interleaved across processes. acquireLock is
// NON-BLOCKING (returns null on a live fresh holder); acquireIdLock adds a
// BOUNDED sync retry (Atomics.wait — cross-platform, no busy-spin) so the common
// case — the other critical section finishing in a few ms — actually serializes,
// then FAILS OPEN (proceeds UNLOCKED) rather than ever wedging a legitimate
// action. The lock is best-effort mutual exclusion layered UNDER the existing
// inode/ownership re-checks, never a hard gate.
// Monotonic per-process counter for unique staged temp filenames (P2-10).
let heartbeatTmpCounter = 0;
// nextHeartbeatTmp() -> the next value of the per-process temp-filename counter.
// The counter's ONE home is this module (it is written by writeRecoveryIntent here
// and by cmdHeartbeat/migrateOwnerKeys in the dispatcher); everyone bumps it
// through this function so there is never a second `let` copy of it.
function nextHeartbeatTmp() { return heartbeatTmpCounter++; }
function acquireIdLock(id, home, opts) {
  const o = opts || {};
  const budgetMs = Number.isFinite(o.budgetMs) ? o.budgetMs : 2000;
  const stepMs = 25;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    let release = null;
    try { release = acquireLock(id, home); } catch (_) { release = null; }
    if (typeof release === 'function') return release;
    if (Date.now() >= deadline) return null; // fail-open: proceed unlocked
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs); } catch (_) { /* sleep best-effort */ }
  }
}
// withIdLock(id, home, fn, opts) — run fn() under the per-id lock, ALWAYS
// releasing in finally. FAILS CLOSED (G1): if the lock cannot be acquired within
// acquireIdLock's budget (a live, fresh holder is mid-mutation), fn is NOT run —
// running it unlocked would silently defeat the register/archive/reap/re-home
// serialization the lock exists for. Returns a `{ok:false, lockBusy:true}`
// surface the caller reports (never treated as success). This is safe against a
// permanent wedge because acquireLock (recovery.js) STEALS a dead holder's lock
// and any lock older than LOCK_STALE_MS (15min) — so only a genuinely live-
// contended mutation is refused, and the caller may retry.
function withIdLock(id, home, fn, opts) {
  const release = acquireIdLock(id, home, opts);
  if (typeof release !== 'function') {
    return {
      ok: false,
      lockBusy: true,
      id,
      error: 'workspace ' + JSON.stringify(id) + ' is locked by another operation in progress; retry shortly',
    };
  }
  const key = heldIdLockKey(id, home);
  HELD_ID_LOCKS.set(key, (HELD_ID_LOCKS.get(key) || 0) + 1);
  try {
    const out = fn();
    // The lock (and HELD_ID_LOCKS) is released when fn RETURNS: an async callback
    // would keep writing after release, unlocked. Refuse it loudly.
    if (out && typeof out.then === 'function') {
      throw new Error('withIdLock(' + JSON.stringify(String(id)) + '): the callback returned a Promise — the lock is released on return, so async work would run unlocked; pass a synchronous callback');
    }
    return out;
  }
  finally {
    const n = (HELD_ID_LOCKS.get(key) || 1) - 1;
    if (n > 0) HELD_ID_LOCKS.set(key, n); else HELD_ID_LOCKS.delete(key);
    try { release(); } catch (_) { /* stale/not-ours */ }
  }
}
// HELD_ID_LOCKS — the (home, id) locks THIS process currently holds via
// withIdLock (the lock file itself is not re-entrant). isIdLockHeld is the
// VERIFIED answer to "does my caller hold X's lock?" — never a caller's claim.
const HELD_ID_LOCKS = new Map();
function heldIdLockKey(id, home) { return String(home) + '\u0000' + String(id); }
function isIdLockHeld(id, home) { return HELD_ID_LOCKS.has(heldIdLockKey(id, home)); }
// withIdLockHeld(id, home, fn) — run fn under id's lock: in place when this
// process already holds it (verified), else acquire it (fails closed: lockBusy).
function withIdLockHeld(id, home, fn) {
  return isIdLockHeld(id, home) ? fn() : withIdLock(id, home, fn);
}

// appendIntoPartition(s, home, destId, rows, { via, allowArchivedDest }) ->
//   { status: 'ok'|'busy'|'gone', inserted }.
// THE ONE door for writing rows into a partition the caller does not own (fold
// forward, archived forward, rehome copy, supervisor escalation notice).
//  1. LOCK: runs under withIdLock(destId) — the lock rehome/send/register hold.
//     Held by this process already (VERIFIED via HELD_ID_LOCKS, never claimed)
//     -> in place; else acquired here; busy -> nothing written.
//  2. RECHECK under that lock: destId must still be registered in THIS store.
//     Otherwise a rehome of destId could have moved it away (tombstone) and the
//     rows would land in a store nobody reads. An ARCHIVED-only destination is
//     accepted ONLY with allowArchivedDest:true, which a caller passes solely for
//     rows that are themselves archived-origin (re-retire, archived-row fold):
//     archived partitions are quiet by design, so LIVE mail never goes there.
//  busy/gone write NOTHING: the caller leaves its source rows in place and
//  reports the pass PENDING. Rows must be addressed to destId. `via`: 'mesh'
//  (default, store.appendMeshMessage fields with `to`), 'row' (s.appendMeshRow,
//  `workspaceId`), 'message' (s.appendMessage, `workspaceId`). Store errors throw.
function appendIntoPartition(s, home, destId, rows, opts) {
  const o = opts || {};
  const dest = String(destId);
  const via = o.via || 'mesh';
  for (const f of rows || []) {
    const addr = f ? (via === 'mesh' ? f.to : f.workspaceId) : null;
    if (addr == null || String(addr) !== dest) throw new Error('appendIntoPartition: row not addressed to ' + JSON.stringify(dest));
  }
  const r = withIdLockHeld(dest, home, () => {
    let present = false;
    try { present = (s.listRegistry() || []).some((x) => x && x.id != null && String(x.id) === dest); }
    catch (_) { present = false; }
    if (!present && !(o.allowArchivedDest && isArchivedOnlyWorkspace(home, dest))) return { status: 'gone', inserted: 0 };
    let inserted = 0;
    for (const f of rows || []) {
      const w = via === 'row' ? s.appendMeshRow(f) : (via === 'message' ? s.appendMessage(f) : store.appendMeshMessage(s, f));
      if (w && w.inserted) inserted++;
    }
    return { status: 'ok', inserted };
  });
  if (r && r.lockBusy) return { status: 'busy', inserted: 0 };
  return r;
}

// ----- paths -----
function workspacesDir(home) { return path.join(devswarmRoot(home), 'workspaces'); }
function archivedDir(home) { return path.join(devswarmRoot(home), 'archived'); }

// hasArchivedCounterpart(home, id) -> bool. True iff archived/<id>.json exists
// for this id — i.e. the id was already archived at some point. Read-only
// (fs.existsSync), fail-closed to false on any error (never claims an
// archived counterpart that couldn't actually be confirmed). Used by the
// worktree-gone detect-and-skip paths below (cmdReconcile's target loop,
// rehomeStrandedProjectDescriptors, healRegistry) so a stale live descriptor
// whose worktree no longer exists — but which was already archived and left
// un-pruned — is recognized and SKIPPED, never deleted or mutated.
function hasArchivedCounterpart(home, id) {
  if (!id || !isSafeId(String(id))) return false;
  try { return fs.existsSync(path.join(archivedDir(home), id + '.json')); }
  catch (_) { return false; }
}

// archivedCounterpartInfo(home, id, currentWorktreePath) -> discriminates a
// SAME-id archived record that is genuinely the same workspace being
// resurrected from one that merely REUSES the id (branch/worktree-derived ids
// are commonly reused after a workspace is archived — see P1-b field defect).
// Discriminator: the archived descriptor's `worktreePath` (the one piece of
// identity every descriptor carries — see buildDescriptorFromFlags; there is
// no createdAt/sourceBranch/builderId field on the persisted shape) compared,
// realpath-resolved when possible, against the CURRENT invocation's resolved
// worktree. Read-only, fail-closed on descriptor-read errors (treated as "no
// archived counterpart" — never blocks on an unreadable tombstone).
//   sameWorkspace: true  -> same worktree path: genuinely the same workspace.
//   sameWorkspace: false -> different worktree path: a NEW workspace reusing
//     this id; the archive-resurrection guard must not refuse it.
//   sameWorkspace: null  -> ambiguous (missing/unresolvable worktree info on
//     either side) — callers should fail OPEN and report loudly (see
//     cmdRegister's requireNew branch).
function archivedCounterpartInfo(home, id, currentWorktreePath) {
  if (!id || !isSafeId(String(id))) return { exists: false };
  const p = path.join(archivedDir(home), id + '.json');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (_) { return { exists: false }; }
  let desc;
  try { desc = JSON.parse(raw); }
  catch (_) { return { exists: true, sameWorkspace: null, unreadable: true }; }
  const archivedWorktree = desc && typeof desc.worktreePath === 'string' && desc.worktreePath
    ? desc.worktreePath : null;
  const current = typeof currentWorktreePath === 'string' && currentWorktreePath
    ? currentWorktreePath : null;
  if (!archivedWorktree || !current) {
    return { exists: true, descriptor: desc, sameWorkspace: null, archivedWorktreePath: archivedWorktree };
  }
  let a = archivedWorktree;
  let c = current;
  try { a = fs.realpathSync(archivedWorktree); } catch (_) { /* worktree may be gone; compare raw */ }
  try { c = fs.realpathSync(current); } catch (_) { /* not yet materialized; compare raw */ }
  const same = path.resolve(a) === path.resolve(c);
  return { exists: true, descriptor: desc, sameWorkspace: same, archivedWorktreePath: archivedWorktree };
}
function checkedArchivedDir(home, { create = false, F } = {}) {
  const G = F || fs;
  const dir = archivedDir(home);
  let st;
  try { st = G.lstatSync(dir); }
  catch (e) {
    if (!e || e.code !== 'ENOENT') return { ok: false, path: dir, error: String(e && e.message || e) };
    if (!create) return { ok: true, path: dir, exists: false };
    try {
      G.mkdirSync(dir, { recursive: true });
      st = G.lstatSync(dir);
    } catch (mkdirError) {
      return { ok: false, path: dir, error: String(mkdirError && mkdirError.message || mkdirError) };
    }
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    return { ok: false, path: dir, error: 'archived path is not a real directory' };
  }
  return { ok: true, path: dir, exists: true };
}
function heartbeatsDir(home) { return path.join(devswarmRoot(home), 'heartbeats'); }
// D13 (v0.97.0) — wake-tick marker + cron-found-mail measurement paths. See
// cmdInboxTick's own header comment for what writes them and why.
function wakeTickDir(home) { return path.join(devswarmRoot(home), 'wake-tick'); }
function wakeTickPathFor(id, home) { return path.join(wakeTickDir(home), id + '.json'); }
function cronFoundMailPath(home) { return path.join(devswarmRoot(home), 'cron-found-mail.jsonl'); }
const CRON_FOUND_MAIL_CAP = 1000;
// TOKEN-SAVING LEVER 1 (0.117.0, devswarm.rearmOnTickOnly): re-arm CUE
// measurement — counts, by trigger, how often this codebase told an agent it
// needed to re-arm a lapsed Monitor watcher. `tick` = the cron tick observed
// `watcherArmed:false` here (the one surviving re-arm trigger once
// rearmOnTickOnly is on); `expiry` = the pre-0.117.0 inline "re-arm on the
// Monitor's own final/expired event" trigger, which hooks/lib/devswarm-wake.js
// monitorArmLine() no longer emits when rearmOnTickOnly is on — this bucket is
// EXPECTED to read 0 in that mode; a caller still on rearmOnTickOnly=false can
// write it to prove the legacy double-trigger. Fail-open, capped, same shape
// as cron-found-mail.jsonl above.
function rearmMetricsPath(home) { return path.join(devswarmRoot(home), 'rearm-cues.jsonl'); }
const REARM_METRICS_CAP = 1000;
function recordRearmCue(home, id, trigger, extra) {
  try {
    const p = rearmMetricsPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let lines = [];
    try { lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch (_) { lines = []; }
    lines.push(JSON.stringify(Object.assign({ ts: Date.now(), id, trigger }, extra || {})));
    if (lines.length > REARM_METRICS_CAP) lines = lines.slice(lines.length - REARM_METRICS_CAP);
    fs.writeFileSync(p, lines.join('\n') + '\n');
  } catch (_) { /* fail-open: measurement only, never breaks the caller */ }
}
// heartbeatCallersLogPath / appendHeartbeatCallerLog (spec item 1b, A1-INSTRUMENT):
// field evidence showed a dead registry row's updatedAt refreshed every ~30-45s by
// an unidentified caller invoking `heartbeat` WITHOUT --session (source:'cli-heartbeat',
// sessionId:null — matches cmdHeartbeat, NOT the legit bin/devswarm-heartbeat.sh
// daemon, which writes a different schema to a different filename). Instrumentation
// only: append one NDJSON line (pid, ppid, argv-source, target id, ts) so the caller
// can be attributed in the field. Fail-open (never throws, never blocks the real
// heartbeat write); capped to the last ~200 lines so the file can't grow unbounded.
function heartbeatCallersLogPath(home) { return path.join(devswarmRoot(home), 'heartbeat-callers.log'); }
const HEARTBEAT_CALLERS_LOG_CAP = 200;
function appendHeartbeatCallerLog(home, id, now) {
  try {
    const line = JSON.stringify({
      ts: Number.isFinite(now) ? now : Date.now(),
      pid: process.pid,
      ppid: typeof process.ppid === 'number' ? process.ppid : null,
      argv: Array.isArray(process.argv) ? process.argv.slice(0, 4).join(' ') : null,
      id,
    });
    const p = heartbeatCallersLogPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let prior = [];
    try { prior = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch (_) { prior = []; }
    prior.push(line);
    if (prior.length > HEARTBEAT_CALLERS_LOG_CAP) prior = prior.slice(prior.length - HEARTBEAT_CALLERS_LOG_CAP);
    fs.writeFileSync(p, prior.join('\n') + '\n');
  } catch (_) { /* fail-open: instrumentation only, never breaks a heartbeat */ }
}
function archiveIgnoreDir(home) { return path.join(devswarmRoot(home), 'archive-ignore'); }
function descriptorPath(home, id) { return path.join(workspacesDir(home), id + '.json'); }
// The durable ACK cursor for the Primary/store read-path. Lives under cursors/ — an
// ALLOW location for the read-guard, deliberately NOT under store/ or inbox/ (which
// hold the message trail itself). A bare integer = consumed message count.
function primaryCursorPath(home, id) { return path.join(devswarmRoot(home), 'cursors', id + '.json'); }

// retiredRedirectPath(home, id) / writeRetiredRedirect / readRetiredRedirect
// (defect 73303d4c098b) — a NEW, purely ADDITIVE side-channel recording "id X
// was folded into survivor Y", so `send`/`read-primary` against a just-folded
// twin id can follow ONE hop to the survivor instead of failing closed as
// unregistered-recipient / unregistered-workspace. Deliberately NOT a field on
// the registry row itself: foldGroupIntoSurvivor's tombstone (removeRegistryIf)
// DELETES the row outright in both backends (sqlite DELETE, NDJSON reduces the
// id out of listRegistry() entirely) — there is no row left to carry a field on
// once the fold has run. A separate per-id file under devswarmRoot mirrors the
// existing descriptorPath/primaryCursorPath convention exactly (same
// `<devswarmRoot>/<subdir>/<id>.json` shape), so it needs no new store backend
// support and no reduceRegistry/removeRegistryIf change in either backend.
// Fail-open throughout: a missing/unreadable/corrupt file reads as "no
// redirect" (readRetiredRedirect returns null), which is EXACTLY today's
// pre-fix behavior for every existing installation and for a row that was
// never folded — so this needs no forward-migration in update.js/doctor: it
// adds a brand-new optional file, not a new shape on an EXISTING persisted
// row, and every reader already treats its absence as the no-redirect case.
function retiredRedirectDir(home) { return path.join(devswarmRoot(home), 'retired'); }
function retiredRedirectPath(home, id) { return path.join(retiredRedirectDir(home), id + '.json'); }
function writeRetiredRedirect(home, retiredId, survivorId) {
  try {
    const dir = retiredRedirectDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const p = retiredRedirectPath(home, retiredId);
    fs.writeFileSync(p, JSON.stringify({ retiredTo: String(survivorId), at: Date.now() }));
  } catch (_) { /* best-effort: a missed tombstone write just means no redirect hint later; the fold itself already succeeded */ }
}
function readRetiredRedirect(home, id) {
  try {
    // H fix: `id` reaches this function from caller-controlled input (a send/
    // read target) and is joined straight into a filesystem path below with
    // no validation — an id like `../../etc/passwd` (or any traversal
    // sequence) would previously be handed unchecked to fs.readFileSync via
    // retiredRedirectPath's path.join. Same isSafeId guard every other
    // id-keyed path helper in this file already applies before path.join.
    if (!isSafeId(String(id))) return null;
    const raw = fs.readFileSync(retiredRedirectPath(home, id), 'utf8');
    const j = JSON.parse(raw);
    if (j && j.retiredTo != null && String(j.retiredTo) !== '') return String(j.retiredTo);
    return null;
  } catch (_) { return null; } // fail-open: no file / bad JSON -> no redirect (pre-fix behavior)
}

// ----- G2 crash-safe archive: recovery-intent markers -----
// A durable per-id marker written BEFORE cmdArchive tombstones a registry row and
// cleared only after the archive fully completes OR the registry row is verifiably
// restored. Its purpose: if the in-process rollback ALSO fails (e.g. ENOSPC
// defeats the revive upsert), or the process is killed between the tombstone and
// its clearance, a durable record survives so doctor/next-run can revive the row
// — closing the split-brain window (active descriptor + tombstoned registry) the
// P1-3 all-or-nothing sequence otherwise leaves if rollback is swallowed.
function recoveryIntentDir(home) { return path.join(devswarmRoot(home), 'recovery-intent'); }
function recoveryIntentPath(home, id) { return path.join(recoveryIntentDir(home), id + '.json'); }
// descriptorFingerprint(desc) -> sha256 hex of the exact descriptor JSON bytes at
// marker-write time. Lets applyRecoveryIntents tell "archive never finished"
// (descriptor unchanged since the marker was written) apart from "this id was
// re-registered with fresh content after a crashed archive" (descriptor rewritten
// -> new hash) — the ambiguity that let a stale marker clobber a legitimately
// re-registered workspace's fresh registry row.
function descriptorFingerprint(desc) {
  try { return crypto.createHash('sha256').update(JSON.stringify(desc)).digest('hex'); }
  catch (_) { return null; }
}
function writeRecoveryIntent(home, id, payload) {
  const dir = recoveryIntentDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const p = recoveryIntentPath(home, id);
  const tmp = p + '.' + process.pid + '.' + nextHeartbeatTmp() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(payload)); fs.renameSync(tmp, p); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
}
function clearRecoveryIntent(home, id) {
  try { fs.unlinkSync(recoveryIntentPath(home, id)); } catch (_) { /* absent = already clear */ }
}
// registryRowPresent — re-open the store and confirm id is a LIVE (non-tombstoned)
// registry row. A pure fold read (listRegistry), never a summary write, so it is
// safe to call on the rollback path where deriveSummary is the op that failed.
function registryRowPresent(home, id, ownerKey, ctx) {
  try {
    const s = store.openStore({ home, workspaceId: id, hash: ownerKey, backend: ctx.backend, env: ctx.env });
    try { return (s.listRegistry() || []).some((r) => r && String(r.id) === String(id)); }
    finally { s.close(); }
  } catch (_) { return false; }
}

// ----- tiny flag parser -----
// VALUE_REQUIRED_FLAGS (FIX 4b, TRACED): flags whose value is NEVER a bare boolean
// — the next token is consumed unconditionally, even when it itself starts with
// `--` (e.g. `--message "--foo bar"`). Without this, such a value degrades to the
// bare-boolean branch below (`val = true`) and the flag silently loses its text.
// Deliberately scoped to flags that only ever take a value, so this cannot swallow
// the next token for a genuinely boolean flag (e.g. `--json`, `--ack`, `--stdin`).
const VALUE_REQUIRED_FLAGS = new Set(['message', 'message-file']);
// BOOLEAN_ONLY_FLAGS (H fix): the mirror-image problem — flags that are
// ALWAYS bare booleans, never taking a value. Without this, parseArgs' own
// generic "does the next token start with --" heuristic below swallows an
// unrelated POSITIONAL token that happens to immediately follow one of
// these as if it were the flag's own value (e.g. `register-primary --force
// somepath` would read somepath as --force's value instead of leaving it as
// a positional argv[++i] never sees again). Scoped to flags with a proven
// swallow risk (register-primary's `--force` conflict override, cmdMeshRead's
// `--peek`, `send`'s `--answers` reply-correlation marker — fl-wave3/item 8:
// `send`'s own header comment already documents `--answers` as "a bare
// boolean flag", but it was simply missing from this set, so `send --answers
// somePositional --to X` would have silently swallowed `somePositional` as
// --answers' own value instead of leaving it as a positional); extend as new
// bare flags are added.
// 'help' is added here as part of the D4 fix (P0 — `--help` used to fall
// through to real verb execution, including mesh broadcasts): without this,
// a mid-argv `--help` (e.g. `inbox read --help ws1`) would swallow the
// FOLLOWING positional as its own value via the generic heuristic below,
// same failure class BOOLEAN_ONLY_FLAGS already exists to close.
const BOOLEAN_ONLY_FLAGS = new Set(['force', 'peek', 'answers', 'help', 'ack-after-print', 'quiet', 'cc-primary', 'short', 'with-broadcasts']);
// parseArgs(argv) -> { positionals: string[], flags: { name: string[] } }.
// Supports `--name value`, `--name=value`, repeatable (`--set a --set b`), and
// bare boolean flags (`--json`). Values are collected as arrays so a caller can
// take last-wins (single) or the whole list (repeatable).
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok === 'string' && tok.startsWith('--')) {
      let name = tok.slice(2);
      let val = null;
      const eq = name.indexOf('=');
      if (eq !== -1) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      else if (BOOLEAN_ONLY_FLAGS.has(name)) { val = true; }
      else if (VALUE_REQUIRED_FLAGS.has(name) && i + 1 < argv.length) { val = argv[++i]; }
      else if (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) { val = argv[++i]; }
      else { val = true; } // bare boolean flag
      if (!flags[name]) flags[name] = [];
      flags[name].push(val);
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}
function one(flags, name) {
  const v = flags[name];
  if (!v || !v.length) return undefined;
  const last = v[v.length - 1];
  return last === true ? undefined : last;
}
function many(flags, name) {
  const v = flags[name];
  if (!v || !v.length) return [];
  return v.filter((x) => x !== true).map(String);
}
// csvList — flatten repeatable + comma-separated values into a trimmed, deduped list.
function csvList(flags, name) {
  const out = [];
  for (const raw of many(flags, name)) {
    for (const part of String(raw).split(',')) {
      const t = part.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

// ----- descriptor io -----
function readDescriptorFile(home, id, F) {
  const state = readDescriptorPathState(descriptorPath(home, id), F);
  return state.error ? null : state.descriptor;
}
// resolveOrphanDescriptor(home, id, F) -> { descriptor, source }. readDescriptorFile
// above resolves ONLY workspaces/<id>.json — it never consults archivedDir. That
// made healOrphanPartitions' archived-forward branch effectively dead code: its
// `!desc -> unhealable/no-descriptor` bail (below) ran BEFORE hasArchivedCounterpart
// was ever checked, so the archived branch could only fire for an id that STILL had
// a live workspaces/<id>.json file in addition to being archived — measured: of 110
// no-descriptor orphans across this machine's stores, 105 had an archived/<id>.json
// counterpart that this lookup never looked at. This tries the live descriptor
// FIRST (unchanged priority/behavior for every id that still has one), then falls
// back to archived/<id>.json, and reports WHICH source answered so a caller can
// tell a live orphan from a merely-archived one apart (they get different policy —
// see healOrphanPartitions). Read-only; fail-closed to {descriptor:null,source:null}
// on any error, exactly like readDescriptorFile itself.
function resolveOrphanDescriptor(home, id, F) {
  const live = readDescriptorFile(home, id, F);
  if (live) return { descriptor: live, source: 'live' };
  const archivedState = readDescriptorPathState(path.join(archivedDir(home), id + '.json'), F);
  if (!archivedState.error && archivedState.descriptor) {
    return { descriptor: archivedState.descriptor, source: 'archived' };
  }
  return { descriptor: null, source: null };
}
function readDescriptorPathState(p, F) {
  const G = F || fs;
  try {
    const st = G.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) {
      return { exists: true, descriptor: null, error: 'descriptor path is not a regular file' };
    }
    const d = JSON.parse(G.readFileSync(p, 'utf8'));
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      return { exists: true, descriptor: null, error: 'descriptor is not a JSON object' };
    }
    return { exists: true, descriptor: d, error: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false, descriptor: null, error: null };
    return { exists: true, descriptor: null, error: String(e && e.message || e) };
  }
}
// descriptorFileGeneration(p) -> { dev, ino, size, mtimeMs, bytes, descriptor } | null
// NAME NOTE: deliberately NOT `descriptorFingerprint` — that name is already taken
// above by the recovery-intent marker's sha256-of-an-OBJECT helper. Two function
// declarations of one name in a module do not coexist: the later one WINS for the
// whole scope, so reusing it would silently repoint every recovery-intent call
// site at this path-taking function and quietly disable the stale-marker guard.
// The GENERATION identity of one descriptor FILE: its inode identity AND its
// exact bytes. Read as ONE lstat+read so the pair is coherent.
//
// WHY (P0-1/P0-2, retire-a-live-descriptor): every descriptor writer in this
// tree publishes via `writeFileSync(tmp) + renameSync(tmp, path)` — an ATOMIC
// REPLACE, which allocates a NEW INODE at the SAME pathname. So a retirement
// that classified a twin at scan time and then unlinks it BY PATHNAME can
// destroy a completely different, freshly-registered LIVE descriptor that
// happened to take that pathname in between. Comparing this fingerprint,
// re-read INSIDE the per-id lock, against the scan-time one is what proves
// "the thing I classified is still the thing I am about to retire". A rename
// changes `ino` even when the bytes are byte-identical, so this catches a
// same-content re-registration too. Returns null on any error (FAIL CLOSED —
// an unreadable descriptor can never satisfy an equality check).
function descriptorFileGeneration(p, F) {
  const G = F || fs;
  try {
    const st = G.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const raw = G.readFileSync(p);
    let d = null;
    try { d = JSON.parse(raw.toString('utf8')); } catch (_) { return null; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    return {
      dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs,
      bytes: raw.toString('utf8'), descriptor: d,
    };
  } catch (_) { return null; }
}
// sameDescriptorGeneration(a, b) -> boolean. FAIL CLOSED on either side absent.
function sameDescriptorGeneration(a, b) {
  if (!a || !b) return false;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.bytes === b.bytes;
}

// worktreeIsProvablyGone(worktreePath) -> boolean. TRUE only when we can POSITIVELY
// prove the path names nothing on disk: an ABSOLUTE path whose lstat is ENOENT.
//
// Every other answer is FALSE — a relative path (unresolvable without knowing the
// cwd it was persisted under), a missing/empty value, a dangling symlink (a real
// entry), ENOTDIR/EACCES/anything else ("I could not tell"). "I could not prove it
// is gone" must NEVER be read as "it is gone" on a path whose only consumer is a
// decision to RETIRE a descriptor. lstat, not stat, for the dangling-symlink case.
function worktreeIsProvablyGone(worktreePath) {
  if (!worktreePath || typeof worktreePath !== 'string') return false;
  if (!path.isAbsolute(worktreePath)) return false;
  try { fs.lstatSync(worktreePath); return false; }
  catch (e) { return !!(e && e.code === 'ENOENT'); }
}

function descriptorStructuralRepoKey(desc) {
  if (!desc || typeof desc !== 'object') return null;
  if (typeof desc.repoKey === 'string' && desc.repoKey) return desc.repoKey;
  try { return desc.worktreePath ? repokey.repoKeyForWorktree(desc.worktreePath) : null; }
  catch (_) { return null; }
}
function descriptorFreshRepoKey(desc) {
  if (!desc || typeof desc !== 'object' || !desc.worktreePath) return null;
  try { return repokey.repoKeyForWorktree(desc.worktreePath); }
  catch (_) { return null; }
}
// descriptorRegisteredRepoKey(desc, id) -> repoKey | null (defect e586afdaa968).
// "Which PROJECT is this workspace id registered under" — the id-derived
// authority every explicitly-id'd store read must resolve its partition from,
// as opposed to the caller's own cwd.
//
// descriptorFreshRepoKey alone (the pre-fix guard) re-derives from the
// descriptor's worktreePath and returns null the moment that path stops
// resolving — a removed/moved worktree, a repo relocated, git transiently
// unavailable. The guard then silently disengaged and the caller's cwd became
// the de-facto authority for a FOREIGN workspace. The descriptor already
// PERSISTS its project key at registration time (`repoKey`, mirrored into
// `ownerKey`), so fall back to that: a re-derived key when the worktree still
// exists (always the fresher truth — a submodule split changes it without the
// persisted field being updated), else the persisted one.
//
// The legacy per-id HASH bucket (store.hashFromWorkspaceId) is deliberately
// NOT a project key — a workspace registered outside any git repo persists it
// as its ownerKey, and treating it as a registered project would refuse that
// workspace's own reads and disable the sanctioned re-home heal. Excluded
// explicitly.
// THE DEFINITION ITSELF now lives in companion/lib/devswarm-repokey.js
// (`registeredRepoKey`) so hooks/devswarm-parent-gate.js resolves the SAME
// fact from the SAME code — the two used to disagree about the ownerKey
// fallback and drifted into a gate that printed a CLI command the CLI refuses.
// This wrapper is kept purely as the in-file name every call site already uses.
function descriptorRegisteredRepoKey(desc, id) {
  let hashKey;
  try { hashKey = store.hashFromWorkspaceId(id); } catch (_) { hashKey = undefined; }
  return repokey.registeredRepoKey(desc, id, { hashKey });
}

// projectContextMismatch(id, registeredKey, callerKey, verb) -> the ONE refusal
// shape every explicitly-id'd, partition-scoped verb returns when the id's own
// registered project positively disagrees with this invocation's cwd (defect
// e586afdaa968). Shared so `read`, `gate`, `ensure`, `archive` and `inbox ack`
// cannot drift in what they report — each only supplies its own trailing
// remediation clause.
function projectContextMismatch(id, registeredKey, callerKey, tail) {
  return {
    ok: false, id,
    reason: 'project-context-mismatch',
    registeredRepoKey: registeredKey,
    callerRepoKey: callerKey || null,
    error: 'workspace ' + JSON.stringify(id) + ' is registered under project ' + JSON.stringify(registeredKey)
      + (callerKey
        ? (', but the current context resolves to a DIFFERENT project ' + JSON.stringify(callerKey))
        : ', but the current context could not resolve a project (non-git cwd?)')
      + ' — ' + tail,
  };
}
// ---- CROSS-PROJECT AUTHORITY OVERRIDE (defect c2a7813aa7d3, P1) ----------
// The v0.85.0 id-derived authority gate (projectContextMismatch above) closed a
// real cross-project re-home/theft P0 and is working AS DESIGNED — but it left
// NO escape hatch at all, so a legitimate cross-project ARCHIVE (a workspace
// whose worktree lives under another project's repo root, which the owning
// project can no longer reach because its own registration points elsewhere)
// became impossible by any supported route.
//
// THE HATCH IS DELIBERATELY NARROW, because the gate it opens is the one that
// stops data theft:
//   * OPT-IN PER CALL — never an env var, never a config file, never sticky.
//   * MUST NAME THE TARGET — `--force-cross-project <targetId>` is accepted
//     ONLY when its value is EXACTLY the id being acted on. A bare boolean
//     flag, or a copy-pasted flag carrying a DIFFERENT id, is refused. This is
//     what makes the override impossible to apply by accident or by a
//     half-remembered shell-history line: the operator has to restate which
//     workspace they mean, and the two must agree.
//   * AUDITED — every accepted override appends one NDJSON line naming the
//     verb, the id, and BOTH project keys, so a cross-project archive is never
//     invisible after the fact.
//   * ARCHIVE ONLY (see the call sites): the gate also guards `ensure`, `inbox
//     ack` and `gate`, and those are NOT given the hatch. Archive refuses
//     BEFORE it copies or removes anything, so overriding it moves no data —
//     whereas overriding `ensure`/`ack`/`gate` would re-open exactly the
//     cross-project row-copying and foreign-cursor-advancing the gate exists
//     to prevent. The defect asked for an archive hatch; widening it further
//     would re-introduce the P0.
const AUTHORITY_OVERRIDE_LOG_FILE = 'devswarm-authority-override.log';
// forceCrossProjectOverride(flags, id) -> {provided, accepted, value}
function forceCrossProjectOverride(flags, id) {
  const raw = one(flags, 'force-cross-project');
  if (raw === undefined) return { provided: false, accepted: false, value: null };
  const value = String(raw);
  return { provided: true, accepted: value === String(id), value };
}
// logAuthorityOverride(entry) -> void. ONE NDJSON line per accepted override.
// Best-effort by design: an unwritable log directory must never turn a
// legitimate, explicitly-authorised archive into a failure — but the write is
// attempted first and only its FAILURE is swallowed, so the audit trail exists
// in every normal environment. Uses alog.logDir() (not a hand-rolled
// os.homedir() join) so it honours the same ANTI_HALL_LOG_DIR override every
// other log in this plugin does, and tests never touch the real home.
// `home` (R12 hygiene (b)): the CALLER's home, i.e. `ctx.home`. Without it this
// wrote into the REAL `os.homedir()` even when the CLI was invoked against an
// isolated home — so a test run (or any caller pointed at a scratch home) left
// audit lines in the operator's actual log directory, and the lines an isolated
// home was supposed to collect were nowhere its own reader would look. The
// explicit ANTI_HALL_LOG_DIR override still wins over both (that is its whole
// purpose); `home` only replaces the os.homedir() default.
function logAuthorityOverride(entry, home) {
  try {
    const envOverride = process.env.ANTI_HALL_LOG_DIR;
    const dir = envOverride
      ? envOverride
      : path.join(home || os.homedir(), '.anti-hall', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, AUTHORITY_OVERRIDE_LOG_FILE), JSON.stringify(entry) + '\n');
  } catch (_) { /* best-effort audit: never fails the authorised operation */ }
}
// forceCrossProjectHint(id) — appended to the refusal so the hatch is
// DISCOVERABLE from the error itself rather than only from the source.
function forceCrossProjectHint(id, provided, value) {
  if (provided) {
    return ' — `--force-cross-project ' + JSON.stringify(value) + '` does NOT match this workspace id; '
      + 'the override must name the EXACT id being archived: `--force-cross-project ' + String(id) + '`';
  }
  return ' — if this cross-project archive is intentional, re-run with `--force-cross-project '
    + String(id) + '` (the flag must name this exact id; the override is logged). '
    + FORCE_CROSS_PROJECT_ORPHAN_WARNING;
}

// FORCE_CROSS_PROJECT_ORPHAN_WARNING (R12 hygiene (c)) — the consequence the
// hatch never stated. This archive runs from OUTSIDE the workspace's own
// project, so the registry row it removes is removed from the CURRENT project's
// view: any unread still sitting in that workspace's partition IN ITS OWN
// PROJECT'S STORE is left with no live registry row there, i.e. an orphan
// partition (summary `orphans[]`). Nothing is deleted and nothing is lost — the
// messages stay reachable — but the operator has to know to drain or heal it
// from inside that project, because no sweep run from here can do it for them.
const FORCE_CROSS_PROJECT_ORPHAN_WARNING =
  'NOTE: archiving across projects removes the row from THIS project only — if that workspace '
  + 'still has unread messages, its partition becomes an ORPHAN in its own project (nothing is '
  + 'deleted; drain or heal it from inside that project).';

function descriptorPhysicalOwnerKey(desc) {
  if (desc && typeof desc.ownerKey === 'string' && desc.ownerKey) return desc.ownerKey;
  return descriptorStructuralRepoKey(desc);
}
function writeDescriptorAtomic(home, id, desc, F) {
  const G = F || fs;
  const dir = workspacesDir(home);
  G.mkdirSync(dir, { recursive: true });
  const p = descriptorPath(home, id);
  const tmp = p + '.tmp';
  G.writeFileSync(tmp, JSON.stringify(desc));
  G.renameSync(tmp, p);
  return p;
}

// buildDescriptorFromFlags(id, flags, existing, env) — merge flag values over an
// existing descriptor (so ensure/re-register only overrides what was passed).
// `repoId` (#36 cross-project-bleed fix) is the one field sourced from BOTH an
// explicit --repo-id flag AND env.DEVSWARM_REPO_ID: an explicit flag wins (an
// operator overriding for a one-off registration), otherwise a truthy env value
// wins (the normal per-session case — hivecontrol sets this for every DevSwarm
// child + the Primary alike), otherwise the existing descriptor's value (if any)
// is preserved untouched, same merge-preserve posture as the other fields.
function buildDescriptorFromFlags(id, flags, existing, env) {
  const base = existing && typeof existing === 'object' ? Object.assign({}, existing) : {};
  base.id = id;
  const worktree = one(flags, 'worktree');
  const session = one(flags, 'session');
  const inbox = one(flags, 'inbox');
  const cursor = one(flags, 'cursor');
  const nudge = many(flags, 'nudge');
  const repoIdFlag = one(flags, 'repo-id');
  // ABSOLUTE, always (P1). A persisted RELATIVE worktreePath is only meaningful
  // against the cwd it was registered from — a fact the descriptor does not carry.
  // Every consumer resolves it against its OWN cwd instead: hooks/devswarm-parent-
  // gate.js's `worktreeIsGone` lstats it from the Primary's repo root, gets ENOENT
  // for a LIVE workspace registered elsewhere, and suppresses the missing-inbox
  // block for it. Resolve here, at the one place descriptors are built, so the
  // persisted value means the same thing to every reader. `path.resolve` is a pure
  // string op (no fs, no throw) and is a no-op on an already-absolute path.
  if (worktree !== undefined) {
    base.worktreePath = (typeof worktree === 'string' && worktree)
      ? path.resolve(worktree)
      : worktree;
  }
  if (session !== undefined) base.sessionId = session;
  if (inbox !== undefined) base.inboxPath = inbox;
  if (cursor !== undefined) base.cursorPath = cursor;
  if (nudge.length) base.nudgeCommand = nudge;
  if (repoIdFlag !== undefined) base.repoId = repoIdFlag;
  else if (env && env.DEVSWARM_REPO_ID) base.repoId = env.DEVSWARM_REPO_ID;
  // normalize the fields the store/consumers expect to exist as keys
  if (base.worktreePath === undefined) base.worktreePath = null;
  if (base.sessionId === undefined) base.sessionId = null;
  if (base.inboxPath === undefined) base.inboxPath = null;
  if (base.cursorPath === undefined) base.cursorPath = null;
  if (base.nudgeCommand === undefined) base.nudgeCommand = null;
  if (base.repoId === undefined) base.repoId = null;
  return base;
}

// repoKeyForCwd(ctx) -> repoKey | null. Fail-open (never throws) resolution of
// THIS invocation's project key from ctx.cwd (defaulting to process.cwd()) —
// shared by every D24-rekeyed store caller below (register/gate/archive/inbox
// messages) so each targets the SAME shared per-project store `send`/`roster`
// read, instead of the pre-mesh legacy per-id hash bucket. null (non-git cwd)
// is fail-open: every caller below falls back to its EXISTING pre-mesh hash
// selection.
function repoKeyForCwd(ctx) {
  try { return identityContext((ctx && ctx.cwd) || process.cwd(), CALLER_CWD).repoKey || null; } catch (_) { return null; }
}
function storeOwnerKeyFor(id, ctx) {
  return repoKeyForCwd(ctx) || store.hashFromWorkspaceId(id);
}

// upsertStoreRegistry — open the store, upsert one descriptor, re-derive summary,
// close. Kept in one place so every write path refreshes the projection.
//
// v0.57 mesh (D24 store-caller re-key): the registry now lands in the SHARED
// per-project store/<repoKey>/ (when repoKey resolves) — the SAME store `mesh
// send`'s fail-closed roster (D12a) and `roster` read — instead of the legacy
// store/<hashFromWorkspaceId(desc.id)>/ bucket, which the mesh CLI never reads.
// Without this, `register`/`ensure` populate an address book NOTHING looks at
// and every mesh direct send is rejected as unregistered. `desc.id` (the
// registry entry's id / self-registration partition, D19) is UNCHANGED — only
// WHICH physical store is opened changes.
// opts (F-B, v0.61.2): forwarded verbatim to the store's upsertRegistry — in
// particular opts.allowPathChange, the F2 guard's explicit same-id path-change
// opt-in (see devswarm-store.js's upsertRegistry comment). Returns the store
// call's result (true = written, false = the F2 guard silently skipped the
// write) so a caller that assumes success (cmdRegister) can detect a skip
// instead of reporting a false ok:true with a descriptor/registry divergence.
function upsertStoreRegistry(home, desc, ctx, opts) {
  const ownerKey = desc.ownerKey || storeOwnerKeyFor(desc.id, ctx);
  const s = store.openStore({
    home, workspaceId: desc.id, hash: ownerKey,
    backend: ctx && ctx.backend, env: ctx && ctx.env,
  });
  try {
    const wrote = s.upsertRegistry(desc, opts);
    store.deriveSummary(s, { home, env: ctx && ctx.env });
    return wrote;
  } finally { s.close(); }
}

function retiredMarkersDir(home) { return path.join(devswarmRoot(home), 'archived-retired'); }

// ============================================================================
// v0.57 mesh CLI surface (send / roster / mesh read) — PLAN-v0.57-mesh.md
// Phase 4. A mesh send writes THIS project's shared store/<repoKey>/ DIRECTLY
// (D8, daemon-independent — decouples send availability from ingest-daemon
// health; ZERO hivecontrol calls) via the store-layer mesh primitives already
// shipped in Phase 2 (meshMessageHash/appendMeshMessage/deriveSummary).
// ============================================================================
const ALLOWED_URGENCY = ['low', 'normal', 'high', 'urgent'];

// hasFlag(flags, name) -> true iff `--name` was passed at all (bare boolean OR
// with a value) — distinct from `one()`, which returns undefined for a bare
// boolean flag (`--broadcast` with no value).
function hasFlag(flags, name) {
  return !!(flags && Array.isArray(flags[name]) && flags[name].length > 0);
}

// isArchivedOnlyWorkspace(home, id) — is this id's workspace GENUINELY archived?
// True only when archived/<id>.json exists AND workspaces/<id>.json does NOT:
// the archived hardlink alone is not proof (cmdArchive links the descriptor into
// archived/ BEFORE unlinking the active one, so mid-archive BOTH exist, and a
// crash there leaves an active workspace with an archived anchor that
// applyRecoveryIntents reconciles). Requiring the ACTIVE descriptor to be gone
// is the same "the destructive step completed" test applyRecoveryIntents uses.
//
// Why the roster needs this: computeSummary projects any workspace with a live
// registry row as active, and a surviving duplicate row for an archived
// worktree therefore re-projects it as active (the bug retireArchivedWorktreeGroup
// fixes going forward). The roster could only ever ADD archived ids that were
// absent — it had no way to DEMOTE a store-sourced row — so on a registry that
// is already split, an archived workspace kept reading active. Read-only and
// FAIL-OPEN: any unreadable/ambiguous state returns false, i.e. the row projects
// exactly as it does today.
function isArchivedOnlyWorkspace(home, id) {
  return rowStateLib.isArchiveComplete(home, id, fs);
}

// ----- dispatch -----
// logVerbOutcome(op, id, r, ctx) — Csh logger wiring. Emits ONE structured
// error entry to the central JSONL log when a wired verb (send / reconcile /
// inbox pull|messages|read-primary / register|ensure) returns an unsuccessful
// result (ok:false or a swallowed exception), so a Primary can later run
// `devswarm logs` and analyze a child project's recent failures from here.
// STRICTLY ADDITIVE: pure logging, it NEVER alters control flow or the returned
// result and NEVER throws (alog is fail-open, and this is fully try-guarded).
// repoKey is resolved fail-open from cwd; meshId carries the verb's target id
// when the verb has one (send/inbox/register), null otherwise (reconcile).
function logVerbOutcome(op, id, r, ctx) {
  try {
    if (!r || r.ok) return;
    let repoKey = null;
    try { repoKey = repoKeyForCwd(ctx); } catch (_) { repoKey = null; }
    const msg = (r.error != null ? String(r.error) : (r.reason != null ? String(r.reason) : 'verb returned ok:false'));
    alog.logError('devswarm-cli', op, msg, {
      repoKey,
      meshId: id != null ? String(id) : null,
      reason: r.reason != null ? String(r.reason) : undefined,
      msg,
    });
  } catch (_) { /* fail-open: logging must never break the verb */ }
}

// Dispatcher hooks. The dispatcher hands core its run() and its export object at
// load; moved code that used to call run(...) (bound as `run` via cliRun) / the dispatcher export-object member calls directly keeps
// doing so through these (call-time lookups, so no load-time cycle). Standalone use
// of a lib module loads the dispatcher on first call.
let dispatcherRun = null;
let dispatcherExportObject = null;
function setRun(fn) { dispatcherRun = fn; }
function setDispatcherExports(obj) { dispatcherExportObject = obj; }
function cliRun(argv, ctx0) {
  if (!dispatcherRun) require('../devswarm.js');
  return dispatcherRun(argv, ctx0);
}
function dispatcherExports() {
  if (!dispatcherExportObject) require('../devswarm.js');
  return dispatcherExportObject;
}

// CLI_PATH — the dispatcher script (scripts/devswarm.js); PLUGIN_ROOT — the plugin
// root. Computed from THIS file's location (one level below scripts/).
const CLI_PATH = path.join(__dirname, '..', 'devswarm.js');
const PLUGIN_ROOT = path.join(__dirname, '..', '..');

module.exports = {
  os, fs, path, crypto, spawnSync, store, livenessSelect, inboxCursor, devswarmUnread,
  readerCursors, readerIdentity, rowStateLib, rowEligibilityLib, cliRowLog, archiveGateLib,
  archivedCacheLib, isSafeId, devswarmRoot, livenessPathFor, writeVerdict, hasFreshHeartbeat,
  heartbeatTs, worktreeActivityMtime, unreadBacklog, DEFAULT_IDLE_MS, DEFAULT_HEARTBEAT_FRESH_MS,
  isDormantRow, unionPendingFor, isSiblingPartitionLive, rowLivenessState, heartbeatPathFor,
  sessionsDirFor, pidIsAlive, processStartMs, isSessionAliveRow, devswarmIdle, readDescriptors,
  pokeOrEscalate, acquireLock, migrate, pull, devswarmCaps, hcRun, inst, repokey, identity,
  CALLER_CWD, identityContext, runningAntiHallVersion, ingestHealth, isDevswarmActive,
  isForwardableRow, names, planLib, supervisionMetrics, gitTruth, wakeLib, isChildWorkspace,
  isChildWorkspaceCorroborated, stableLauncherLib, resolveStableLauncherPath, resolveStableCliPath,
  warnIdMismatch, alog, acquireIdLock, withIdLock, HELD_ID_LOCKS, heldIdLockKey, isIdLockHeld,
  withIdLockHeld, appendIntoPartition, workspacesDir, archivedDir, hasArchivedCounterpart,
  archivedCounterpartInfo, checkedArchivedDir, heartbeatsDir, wakeTickDir, wakeTickPathFor,
  cronFoundMailPath, CRON_FOUND_MAIL_CAP, rearmMetricsPath, REARM_METRICS_CAP, recordRearmCue,
  heartbeatCallersLogPath, HEARTBEAT_CALLERS_LOG_CAP, appendHeartbeatCallerLog, archiveIgnoreDir,
  descriptorPath, primaryCursorPath, retiredRedirectDir, retiredRedirectPath, writeRetiredRedirect,
  readRetiredRedirect, recoveryIntentDir, recoveryIntentPath, descriptorFingerprint,
  writeRecoveryIntent, clearRecoveryIntent, registryRowPresent, VALUE_REQUIRED_FLAGS,
  BOOLEAN_ONLY_FLAGS, parseArgs, one, many, csvList, readDescriptorFile, resolveOrphanDescriptor,
  readDescriptorPathState, descriptorFileGeneration, sameDescriptorGeneration,
  worktreeIsProvablyGone, descriptorStructuralRepoKey, descriptorFreshRepoKey,
  descriptorRegisteredRepoKey, projectContextMismatch, AUTHORITY_OVERRIDE_LOG_FILE,
  forceCrossProjectOverride, logAuthorityOverride, forceCrossProjectHint,
  FORCE_CROSS_PROJECT_ORPHAN_WARNING, descriptorPhysicalOwnerKey, writeDescriptorAtomic,
  buildDescriptorFromFlags, repoKeyForCwd, storeOwnerKeyFor, upsertStoreRegistry,
  retiredMarkersDir, ALLOWED_URGENCY, hasFlag, isArchivedOnlyWorkspace, logVerbOutcome,
  nextHeartbeatTmp, cliRun, setRun, dispatcherExports, setDispatcherExports, CLI_PATH, PLUGIN_ROOT,
};
