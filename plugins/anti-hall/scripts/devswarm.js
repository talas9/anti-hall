#!/usr/bin/env node
'use strict';
// anti-hall :: devswarm CLI — THE structured interface (CLI over MCP, owner
// preference: no MCP servers) to the DevSwarm coordination substrate. Stable
// JSON on stdout for agent parsing. Pure Node built-ins only, cross-platform.
//
// This is a THIN wrapper that REUSES the already-built primitives — it invents
// no parallel schema:
//   - companion/lib/devswarm-store.js       (openStore / deriveSummary / setGate)
//   - companion/lib/devswarm-inbox-cursor.js (inbox read/ack/count cursor advance)
//   - companion/lib/recovery.js             (pokeOrEscalate — the nudge path)
//   - companion/lib/liveness.js             (isSafeId / devswarmRoot / livenessPathFor)
//   - companion/devswarm-supervisor.js      (readDescriptors — the on-disk registry)
//
// SUBCOMMANDS
//   register <id>  --worktree P --session S --inbox P --cursor P [--nudge T ...]
//                  write ~/.anti-hall/devswarm/workspaces/<id>.json + upsert store
//                  registry. Populates sessionId (closes the null-gap, PLAN.md
//                  "Open ownership gaps").
//   ensure <id>    ...same flags... register-if-absent (idempotent; existing
//                  descriptor is left intact, only the store registry is re-upserted).
//   heartbeat <id> [--progress N --phase X --wip T ... --blockers T ... --session S]
//                  turn-authored heartbeat at heartbeats/<id>.json. Consumer/session
//                  invoked ONLY — never a background ticker (PLAN.md heartbeat
//                  authorship rule).
//   inbox count <id> | inbox read <id> | inbox ack <id> [--to N]
//                  the durable-inbox cursor primitive (advance = ack-all).
//   inbox pull <id> [--session S]
//                  child-side reception drain: auto-ensure the descriptor, then ONE
//                  bounded guard-safe pull — non-destructive `message-count` gate,
//                  at-most-one bounded `read-messages` (never `monitor`), atomic
//                  idempotent NDJSON append into the durable inbox + store parity.
//   workspaces list
//                  derive + emit summary.json projection (unread, gates, archive_ready).
//   gate <id> [--set CSV] [--clear CSV]
//                  mark/unmark named completion gates (append-only in the store).
//                  anti-hall is AGNOSTIC about gate meaning — the consumer sets them.
//   nudge <id>     poke-or-escalate the workspace (reuses recovery.pokeOrEscalate).
//   archive <id>   archive-by-absence on OUR registry ONLY: move the descriptor to
//                  archived/ + tombstone the store registry. hivecontrol has NO
//                  teardown command, so this SURFACES a manual "remove workspace in
//                  the DevSwarm app" step; it never runs a delete (none exists).
//   archive-ignore <id> | archive-unignore <id>
//                  write/remove archive-ignore/<id>.json — the per-workspace ignore
//                  mark the archive-ready surfacing consults (PLAN.md P1-E).
//   archive-request <childId> [--reason TEXT]
//                  v0.58 STORE WRITE (mesh-only messaging): posts a parent->child
//                  `[[ANTIHALL_ARCHIVE_REQUEST]]` message DIRECTLY into `<childId>`'s
//                  own store partition (mesh-direct, urgency 'high') — `childId` is
//                  ALREADY the target's real read partition (same semantics as
//                  `heartbeat <id>`/`inbox read <id>`), so, unlike `send --to
//                  <meshId>`, no registry/meshId resolution happens. ZERO hivecontrol
//                  calls (replaces the old native `list children` + `message-child`
//                  spawn — the one native-messaging leak the guard could never
//                  catch). AGNOSTIC — never verifies merged/tested/deployed itself;
//                  that is the receiving parent's own repo policy.
//   migrate        auto-migrate on-disk state (JSON registry + legacy NDJSON inbox)
//                  into the store. Idempotent, NON-DESTRUCTIVE (never deletes source),
//                  single-consumer-locked, count-verified before it reports success.
//   logs [--repo K] [--component C] [--min-level L] [--since 30m|2h|1d] [--limit N]
//                  READ-ONLY analysis of the shared central JSONL error/event log
//                  (companion/lib/anti-hall-log.js). One central stream across every
//                  project, so a Primary can triage a child's recent failures FROM
//                  HERE. Filterable + rolled up by component/level. Never writes.
//   send --to <meshId>|--to-primary|--broadcast --message TEXT [--from <id>] [--urgency ...]
//                  v0.57 MESH (PLAN-v0.57-mesh.md Phase 4, D8): writes THIS project's
//                  shared store/<repoKey>/ DIRECTLY — daemon-independent, ZERO
//                  hivecontrol calls. `--from` is always re-derived from cwd
//                  (callerIdentity, spoof-proof, D18/D19); an explicit --from must
//                  MATCH or the send is rejected. `--to <meshId>` is fail-closed
//                  against the shared registry (D12a) — an unregistered meshId is
//                  rejected, never silently black-holed. `--to-primary` (v0.58)
//                  resolves the registry entry whose worktree-derived meshId
//                  (via resolveMeshTarget, same identity-hash join `--to` uses)
//                  matches this project's MAIN worktree (install-devswarm-
//                  ingest's resolveMainWorktree) — fail-closed
//                  (`reason:'primary-unregistered'`) when no such entry exists.
//                  A hash join (not literal worktreePath equality) so a
//                  register-primary'd path and a later-resolved main worktree
//                  that are different STRINGS but the same real directory (e.g.
//                  win32 short/long-name spelling) still resolve. A non-git cwd
//                  returns
//                  {ok:false,reason:'no-project'} BEFORE any identity is derived
//                  (D28 — never emits an env-derived `from`).
//   roster [--ack]
//                  ALLOW-listed projection read of this project's shared registry +
//                  `working_on` + `recent[]` broadcast digest. `--ack` (alias of
//                  `mesh read`, D23) advances the CALLER's own broadcast cursor to
//                  head — the ONLY surface that clears `broadcastUnread`. v0.58:
//                  plain `roster` (never `--ack`) additionally FOLDS a read-only
//                  `hivecontrol workspace list children` view into the projection —
//                  a child hivecontrol spawned but that has never yet registered
//                  itself with the store stays visible instead of invisible.
//   mesh read      same as `roster --ack` (D23) — listed separately for discovery.
//   reconcile      v0.58: for every registry descriptor of THIS project with a
//                  worktreePath, spawns `node scripts/devswarm.js inbox pull <id>`
//                  as a SUBPROCESS with cwd=<that worktree> (an in-process call
//                  would drain the WRONG queue — inbox pull's native spawns inherit
//                  the calling process's cwd). Per-id O_EXCL pull lock (already
//                  shipped in devswarm-pull.js) serializes a sweep against a live
//                  child concurrently pulling its own inbox.
//   spawn <branch> [hivecontrol create flags...]
//                  v0.58: THIN pass-through wrap of `hivecontrol workspace create
//                  <branch> ...` (never re-implemented/re-parsed), then
//                  best-effort auto-registers the new worktree in this project's
//                  shared store registry (store-only; the child's own first
//                  inbox-pull/heartbeat/register still fills in its real sessionId).
//   merge [hivecontrol merge-into-source flags...]
//                  v0.58: THIN wrap of `hivecontrol workspace check-merge` +
//                  `hivecontrol workspace merge-into-source ...` (pass-through),
//                  then `send --broadcast`s the outcome to the mesh.
//
// Every id is isSafeId-gated before it is ever path.join'd. Fail-soft: a bad
// subcommand / id reports { ok:false, error } + exit 2, never throws a stack.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const store = require('../companion/lib/devswarm-store.js');
const inboxCursor = require('../companion/lib/devswarm-inbox-cursor.js');
const {
  isSafeId, devswarmRoot, livenessPathFor,
  writeVerdict, hasFreshHeartbeat, worktreeActivityMtime, unreadBacklog, DEFAULT_IDLE_MS,
} = require('../companion/lib/liveness.js');
const { readDescriptors } = require('../companion/devswarm-supervisor.js');
const { pokeOrEscalate, acquireLock } = require('../companion/lib/recovery.js');
const migrate = require('../companion/devswarm-migrate.js');
const pull = require('../companion/lib/devswarm-pull.js');
const inst = require('../companion/install-devswarm-ingest.js');
const repokey = require('../companion/lib/devswarm-repokey.js');
const ingestHealth = require('../companion/lib/ingest-health.js');
const { isDevswarmActive } = require('../hooks/lib/devswarm-detect.js');
const { isForwardableRow } = require('../companion/lib/devswarm-noise.js');
const names = require('../companion/lib/devswarm-names.js');
// Shared structured JSONL logger (C0). Console fallback so a missing/older
// companion never breaks the CLI — logging is strictly additive and fail-open;
// alog.logError NEVER throws into a caller and NEVER changes control flow.
let alog;
try { alog = require('../companion/lib/anti-hall-log'); }
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
  try { return fn(); }
  finally { try { release(); } catch (_) { /* stale/not-ours */ } }
}

// SYNTHETIC_SESSION_PREFIX / isLiveSessionId (A6, v0.66 review): a registry
// row's `sessionId` is the ONLY liveness signal every mesh-addressing/fold
// primitive in this file reads (resolveMeshTarget, pickSurvivor,
// groupRegistryByMeshId, computeDiagnosis, rehomeMiskeyedRow's identity
// confirmation) — "non-empty sessionId" == "a real session is running this
// workspace". cmdInboxPull's auto-ensure/self-register path used to MINT a
// sessionId from `id` itself when neither `--session` nor
// DEVSWARM_BUILDER_ID was supplied, so a reconcile-spawned phantom (a bare
// registry seed with no live session behind it at all) became permanently
// "live" the instant it was auto-ensured — `resolveMeshTarget` could then
// route a `send` to a partition nothing will ever drain.
//
// Fix: mint a value carrying this PREFIX instead of the bare id (still
// non-empty/truthy, satisfying cmdRegister's own "register requires
// --session" validation — a descriptor with a null/empty sessionId is
// rejected outright at creation, so leaving it null is not viable without
// also relaxing that unrelated invariant), and make the shared liveness
// predicate EXCLUDE it explicitly. POLARITY WARNING (named in the review):
// the live filter is "sessionId non-empty" — a marker string would still
// read as live unless every liveness check is updated to exclude it
// deliberately, which is why every liveness check-site in THIS file below is
// migrated to call this one predicate instead of re-deriving the same
// "non-empty" test inline.
const SYNTHETIC_SESSION_PREFIX = 'unclaimed:';
function isLiveSessionId(sessionId) {
  if (sessionId == null) return false;
  const s = String(sessionId);
  if (s === '') return false;
  return !s.startsWith(SYNTHETIC_SESSION_PREFIX);
}

// findGitToplevel(startDir) -> absolute repo-root path | null. A PURE fs walk-up
// looking for a `.git` entry — the same root `git rev-parse --show-toplevel`
// would report, WITHOUT spawning git. Mirrors hooks/devswarm-parent-gate.js /
// devswarm-parent-inbox.js / devswarm-child-turn.js byte-for-byte (kept as a
// local copy rather than a shared require, matching their own stated precedent
// of not adding new cross-file coupling for a few lines of pure fs walk). Used
// as callerIdentity's git-unavailable fallback so it agrees with the parent-gate
// hook's own cwd-derivation even when git is not on PATH.
function findGitToplevel(startDir) {
  try {
    let dir = path.resolve(String(startDir || ''));
    if (!dir) return null;
    for (;;) {
      try {
        fs.statSync(path.join(dir, '.git'));
        return dir;
      } catch (_) { /* keep walking up */ }
      const parent = path.dirname(dir);
      if (parent === dir) return null; // reached filesystem root, no .git found
      dir = parent;
    }
  } catch (_) {
    return null;
  }
}

// callerIdentity(env, cwd) -> string. Who is invoking this CLI process, for the
// ack-ownership check (cross-workspace ack hazard, bug #2).
//
// CWD IS GROUND TRUTH (P0 fix): a caller's cwd tells us, mechanically, which
// worktree/workspace process is actually running. When cwd resolves to a REAL
// git worktree, identity MUST derive from cwd — a `DEVSWARM_BUILDER_ID` env var
// that names a DIFFERENT workspace is IGNORED (never trusted to override), so a
// workspace cannot set `DEVSWARM_BUILDER_ID=<other-id>` (deliberately, or via
// ordinary env inheritance from a parent process) to impersonate another
// workspace and advance ITS cursor. `DEVSWARM_BUILDER_ID` is honored as a
// DECLARED identity only in the two cases where it cannot contradict cwd:
//   1. cwd resolves to a worktree AND the env value already MATCHES the
//      cwd-derived id (redundant declaration, not an override).
//   2. cwd does NOT resolve to any git worktree at all (no ground truth exists
//      to contradict it) — e.g. a daemon/unit whose cwd defaults to $HOME.
// Worktree resolution: resolveWorktree(cwd) (git spawn) first, falling back to
// the PURE-FS findGitToplevel(cwd) above when git is unavailable/unspawnable —
// this fallback ORDER matters: it keeps callerIdentity agreeing with the
// parent-gate hook's OWN cwd-derivation (which is pure-fs only, no git spawn)
// even when git cannot be spawned, instead of silently falling further back to
// the RAW cwd (which would misidentify a subdirectory as its own worktree and
// spuriously refuse a legitimate Primary self-ack run from a non-toplevel cwd
// with git unavailable). Only when NEITHER resolves does cwd fail to resolve to
// a workspace at all (case 2 above; final fallback = primaryWorkspaceId(raw
// cwd) so callerIdentity always returns a deterministic non-empty string).
// resolveCallerWorktree(cwd) -> the RESOLVED git worktree/toplevel for `cwd`, or
// null when `cwd` is not inside any git worktree. This is the SINGLE primitive
// used to canonicalize a cwd into a workspace identity: git `resolveWorktree`
// first, then the pure-fs `findGitToplevel` fallback (same order + rationale as
// callerIdentity's original inline resolution). Callers that must agree on a
// worktree's meshId — callerIdentity (identity derivation) AND cmdInboxPull (the
// registered worktreePath that `send --to` later hashes) — MUST route through
// this so a subdirectory cwd canonicalizes to the SAME toplevel both places
// (bug: a child that ran `inbox pull` from a git SUBDIR registered the raw
// subdir path, which hashed to a meshId no `send --to` could resolve — the child
// became unaddressable, failing closed as `unregistered-recipient`).
function resolveCallerWorktree(cwd) {
  const c = cwd || process.cwd();
  return inst.resolveWorktree(c) || findGitToplevel(c) || null;
}
// callerIdentityDetailed(env, cwd) -> { identity, kind }. Same resolution as
// callerIdentity below, but ALSO names WHICH of the three legs produced the
// identity (A7, v0.66 review) — 'resolved' (cwd matched a real git worktree —
// independently-verifiable ground truth), 'declared' (no worktree ground
// truth, but a DEVSWARM_BUILDER_ID env value was trusted — a legitimate,
// still-meaningful declaration), or 'unresolvable' (neither — the raw-cwd-
// hash fallback: this identity carries NO independently-verifiable ground
// truth at all, the ambiguous case a caller-ownership refusal reason must be
// able to name explicitly instead of collapsing into the same generic "does
// not own workspace" text as a genuine mismatch).
function callerIdentityDetailed(env, cwd) {
  const bid = env && env.DEVSWARM_BUILDER_ID ? String(env.DEVSWARM_BUILDER_ID) : null;
  const c = cwd || process.cwd();
  const wt = resolveCallerWorktree(c);
  if (wt) return { identity: inst.primaryWorkspaceId(wt), kind: 'resolved' };
  if (bid) return { identity: bid, kind: 'declared' };
  return { identity: inst.primaryWorkspaceId(c), kind: 'unresolvable' };
}
function callerIdentity(env, cwd) {
  const bid = env && env.DEVSWARM_BUILDER_ID ? String(env.DEVSWARM_BUILDER_ID) : null;
  const c = cwd || process.cwd();
  const wt = resolveCallerWorktree(c);
  if (wt) {
    // cwd resolves to a real workspace: identity derives from cwd. A mismatching
    // declared env id is NOT trusted to override it (the spoof this guard exists
    // to close); a matching one is a no-op (same value either way).
    return inst.primaryWorkspaceId(wt);
  }
  // No ground truth: cwd does not resolve to any workspace. A declared env
  // identity is trusted here (nothing to contradict it); otherwise fall back to
  // a deterministic id derived from the raw cwd (fail-open, never null).
  if (bid) return bid;
  return inst.primaryWorkspaceId(c);
}
// ownershipRefusalCause(callerKind, ownEntry) -> a stable reason string naming
// WHICH leg of the ownership check failed (A7): the caller's own identity had
// no verifiable ground truth at all ('unresolvable-caller-identity'), the
// caller resolved fine but has no registry entry of its own in this store
// ('caller-not-registered'), or the caller IS registered but under a
// DIFFERENT id than the one it tried to act on ('ownership-mismatch').
function ownershipRefusalCause(callerKind, ownEntry) {
  if (callerKind === 'unresolvable') return 'unresolvable-caller-identity';
  if (!ownEntry) return 'caller-not-registered';
  return 'ownership-mismatch';
}

// BENIGN_MESH_BROADCAST_REASONS — meshBroadcast failure `reason` values that
// must NEVER escalate cmdHeartbeat's top-level `ok` (see its use at the end
// of cmdHeartbeat). Both are DELIBERATE, tested exceptions:
//   - 'no-project': O-D5 "mesh dormant" — a non-git cwd is an ordinary
//     environment fact, not a caller mistake.
//   - ownershipRefusalCause()'s closed set: a working security control
//     refusing a (possibly forged) broadcast is not this call's own local-
//     write failure — devswarm-send.test.js's "forged" test explicitly
//     documents "the base (local) heartbeat write is not itself the
//     security boundary" and asserts ok:true through this exact path.
const BENIGN_MESH_BROADCAST_REASONS = new Set([
  'no-project',
  'unresolvable-caller-identity', 'caller-not-registered', 'ownership-mismatch',
]);

// ----- paths -----
function workspacesDir(home) { return path.join(devswarmRoot(home), 'workspaces'); }
function archivedDir(home) { return path.join(devswarmRoot(home), 'archived'); }
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
function archiveIgnoreDir(home) { return path.join(devswarmRoot(home), 'archive-ignore'); }
function descriptorPath(home, id) { return path.join(workspacesDir(home), id + '.json'); }
// The durable ACK cursor for the Primary/store read-path. Lives under cursors/ — an
// ALLOW location for the read-guard, deliberately NOT under store/ or inbox/ (which
// hold the message trail itself). A bare integer = consumed message count.
function primaryCursorPath(home, id) { return path.join(devswarmRoot(home), 'cursors', id + '.json'); }

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
  const tmp = p + '.' + process.pid + '.' + (heartbeatTmpCounter++) + '.tmp';
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
  if (worktree !== undefined) base.worktreePath = worktree;
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
  try { return repokey.repoKeyForWorktree((ctx && ctx.cwd) || process.cwd()); } catch (_) { return null; }
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

// ---------------------------------------------------------------------------
// MESH ROW COPY — the ONE definition of which fields a copied message row
// carries. There are exactly TWO sites in this file that copy an existing mesh
// row into another partition/store: rehomeAcrossStores (a VERBATIM move into
// another store, via the low-level `store.appendMeshRow`) and
// foldGroupIntoSurvivor (a FORWARD into the survivor partition, via the
// wire-contract `store.appendMeshMessage`). Those two APIs name the SAME data
// DIFFERENTLY (`sender`/`from`, `body`/`message`, `ts`/`timestamp`,
// `mtype`/`type`), so each site used to spell its own object literal out by
// hand — which is precisely how the historical `needsReply`-drop bug class
// recurred: a new message field added to the wire contract was carried at one
// site and silently forgotten at the other, and a dropped flag is invisible
// (the row still copies, it just loses its meaning). One table now defines the
// canonical field set; a new field is added HERE, once, and both shapes get it.
//
// `msg: null` means "this field is deliberately NOT part of the forward shape":
//   - hash        — a FORWARD re-addresses the row (new recipient), so its hash
//                   MUST be recomputed from the new fields (that recomputation
//                   is what makes a re-run OR-IGNORE instead of duplicating).
//                   A verbatim re-home keeps the original hash for exactly the
//                   same dedup reason.
//   - isHeartbeat — a heartbeat can never reach the forward site at all:
//                   isForwardable/isForwardableRow requires mtype==='direct',
//                   which structurally excludes every heartbeat/broadcast row.
//                   Carrying the flag there would imply forwards can be
//                   heartbeats; they cannot. The verbatim re-home DOES carry it
//                   (it moves rows untouched, heartbeat or not).
const MESH_ROW_COPY_FIELDS = [
  // { row: key on a stored row / appendMeshRow, msg: key on appendMeshMessage }
  { row: 'sender', msg: 'from' },
  { row: 'recipient', msg: 'to' },
  { row: 'body', msg: 'message' },
  { row: 'ts', msg: 'timestamp' },
  { row: 'mtype', msg: 'type' },
  { row: 'urgency', msg: 'urgency' },
  { row: 'needsReply', msg: 'needsReply' },
  { row: 'hash', msg: null },
  { row: 'isHeartbeat', msg: null },
];

// meshRowCopy(m, shape, overrides) -> a copy payload for `shape`:
//   'row'     -> appendMeshRow field names (verbatim move; caller supplies workspaceId)
//   'message' -> appendMeshMessage field names (forward; caller supplies the new
//                recipient/type and recomputes the hash)
// `overrides` is applied LAST so a caller can re-address the copy (the forward
// site) without reaching around this helper. Pure — never throws, never reads
// or writes a store.
function meshRowCopy(m, shape, overrides) {
  const src = m || {};
  const out = {};
  for (const f of MESH_ROW_COPY_FIELDS) {
    const key = shape === 'message' ? f.msg : f.row;
    if (!key) continue; // deliberately absent from this shape (see the table's comment)
    out[key] = src[f.row];
  }
  return Object.assign(out, overrides || {});
}

// ---------------------------------------------------------------------------
// STORE RE-HOME (P1-1 / P1-2). A descriptor registered while repoKey was
// transiently null lands its registry row + any messages in the LEGACY hash
// bucket store/<hashFromWorkspaceId(id)>/ — a bucket the Primary's real read
// verbs (`inbox messages`/`read-primary`, keyed off repoKey) never open, so a
// "healed" send into it is a SILENT BLACK HOLE, and once ownerKey=hash is
// persisted the ensure path REJECTS ("does not belong to the current project")
// and locks the workspace out of its own inbox. rehomeCore MIGRATES the registry
// row + pending messages + read cursor from the hash bucket into the resolved
// store/<repoKey>/ and rewrites ownerKey=repoKey. ATOMIC + FAIL-OPEN +
// NO-DELETE-until-copy-verified: it copies/upserts into the repoKey store,
// VERIFIES every source hash + the registry row landed, and ONLY THEN tombstones
// the hash-bucket registry row (the message rows are append-only and never
// deleted — OR-IGNORE dedup makes a re-run idempotent). MUST be called with the
// per-id lock held (call sites wrap it). Never throws.
//
// Broadcasts/heartbeats live in the SHARED BROADCAST_PARTITION_ID (not per-id)
// and are deliberately NOT re-homed here — only the per-id direct backlog +
// registry row (the addressed traffic the black hole affected) moves.
// rehomeAcrossStores(home, id, fromKey, toKey, ctx) — the GENERALIZED move
// primitive rehomeCore (below) and the Claim 3 self-heal helpers both share:
// migrate id's registry row + pending direct backlog + read cursor from
// store/<fromKey>/ into store/<toKey>/. Same contract as the original
// rehomeCore body: ATOMIC-per-step, FAIL-OPEN, NO-DELETE-until-copy-verified
// (a message row is NEVER deleted — append-only, OR-IGNORE dedup makes a
// re-run idempotent; the SOURCE's registry row is tombstoned ONLY after the
// destination copy is verified present, and only when it actually came FROM
// the source store rather than being seeded from a descriptor-only
// fallback). MUST be called with the per-id lock held (call sites wrap it).
// Never throws.
function rehomeAcrossStores(home, id, fromKey, toKey, ctx) {
  const out = { rehomed: false, movedMessages: 0, movedRegistry: false };
  if (!fromKey || !toKey || fromKey === toKey) return out; // already colocated / nothing to move
  let fromStore = null;
  let toStore = null;
  try {
    // The source bucket may not exist (descriptor-only split-brain) — openStore
    // materializes it, but only when we have already decided a re-home is
    // warranted, so this is not a spurious create. Guard the whole body
    // fail-open regardless.
    fromStore = store.openStore({ home, workspaceId: id, hash: fromKey, backend: ctx && ctx.backend, env: ctx && ctx.env });
    toStore = store.openStore({ home, workspaceId: id, hash: toKey, backend: ctx && ctx.backend, env: ctx && ctx.env });

    // 1) Registry row: prefer the source-store row; fall back to the on-disk
    //    descriptor when the store row is absent (descriptor-only split-brain).
    let regRow = null;
    try { regRow = (fromStore.listRegistry() || []).find((r) => r && String(r.id) === String(id)) || null; } catch (_) { regRow = null; }
    let regFromSource = !!regRow;
    if (!regRow) {
      const d = readDescriptorFile(home, id);
      if (d && String(d.id) === String(id)) regRow = d;
    }
    // Nothing stranded in the source store AND no descriptor to seed a row
    // from: this is NOT a split-brain — do NOT upsert a stub into the
    // destination store (that would CLOBBER a legitimately-registered row). No-op.
    if (!regRow) return out;
    const rehomedReg = Object.assign({}, regRow);
    rehomedReg.id = id;
    rehomedReg.ownerKey = toKey;
    if (descriptorFreshRepoKey(rehomedReg) === toKey) rehomedReg.repoKey = toKey;
    toStore.upsertRegistry(rehomedReg);

    // 2) Pending direct backlog for THIS partition (id) — ONLY the source's
    //    UNREAD tail (sinceCursor: fromCursor), never its already-read history.
    //    appendMeshRow OR-IGNOREs on hash, so a re-run never duplicates.
    //
    //    MESSAGE-LOSS FIX (P0): a read cursor is a POSITIONAL index into ONE
    //    specific ordered list — it is meaningless once copied onto a
    //    DIFFERENT list. Concrete repro this closes: destination already has
    //    an unread [X] at cursor 0; source has [A,B] at cursor 1 (A read, B
    //    unread). Copying source's FULL history (both A and B) after X
    //    produces [X,A,B], and merging cursors via max(0,1)=1 marks position 1
    //    (X) as already-read — X was NEVER delivered to the reader. There is
    //    no cursor value over the merged list that can correctly mark "A read,
    //    X and B unread" when X sorts before A. The only safe fix: copy just
    //    the source's UNREAD tail (so every appended row is genuinely unread)
    //    and leave the destination's OWN cursor completely untouched — its
    //    pre-existing rows keep exactly the read/unread status they already
    //    had, and the newly-appended rows are correctly unread too.
    let fromCursor = 0;
    try { fromCursor = fromStore.cursorValue(id) || 0; } catch (_) { fromCursor = 0; }
    let msgs = [];
    try { msgs = fromStore.listMessages(id, { sinceCursor: fromCursor }) || []; } catch (_) { msgs = []; }
    for (const m of msgs) {
      // VERBATIM move: every field comes from the ONE shared MESH_ROW_COPY_FIELDS
      // table (see meshRowCopy) so this site can never again drift from the
      // forward site in foldGroupIntoSurvivor. Only the destination partition is
      // an override — the row keeps its original hash (dedup) and its heartbeat flag.
      toStore.appendMeshRow(meshRowCopy(m, 'row', { workspaceId: id }));
    }

    // 3) VERIFY the copy landed BEFORE removing anything (no-delete-until-verified).
    const destHashes = new Set((toStore.listMessages(id, { sinceCursor: 0 }) || []).map((r) => r.hash).filter((h) => h != null));
    const allMsgsPresent = msgs.every((m) => m.hash == null || destHashes.has(m.hash));
    // F-D (v0.61.2): a row for `id` reading present is NOT proof the upsert above
    // actually applied — the F2 id-collision guard (upsertRegistry) silently skips
    // when a DIFFERENT non-null worktree_path already occupies this id, and a stale/
    // conflicting row still satisfies a bare `.some(id===id)` check. Compare the
    // fields the upsert was supposed to write, not just id presence, so a guard-
    // skipped write is caught here BEFORE the source is tombstoned as verified.
    const destRow = (toStore.listRegistry() || []).find((r) => r && String(r.id) === String(id)) || null;
    const regPresent = !!destRow
      && (destRow.worktreePath || null) === (rehomedReg.worktreePath || null)
      && (destRow.sessionId || null) === (rehomedReg.sessionId || null);
    if (!allMsgsPresent || !regPresent) {
      // Verification failed — LEAVE the source store intact (fail-open, zero loss);
      // a later attempt retries. Reader falls back to current resolution meanwhile.
      // F-D: distinguish a genuine CONFLICT (a destination row exists but does not
      // match — the F2 guard skipped the upsert) from a plain not-yet-verified
      // state (no destination row at all) — surface it on `out` + stderr instead
      // of a silent no-op, so the conflict is observable rather than swallowed.
      if (destRow && !regPresent) {
        out.regConflict = true;
        try {
          process.stderr.write('[devswarm] rehomeAcrossStores: id ' + JSON.stringify(String(id))
            + ' — destination already has a CONFLICTING registry row (worktreePath/sessionId'
            + ' mismatch, likely the F2 id-collision guard skipping the upsert); source NOT'
            + ' tombstoned, conflict surfaced.\n');
        } catch (_) {}
      }
      // Rows were already appended to toStore (:684-689) and the registry upserted
      // (:660) BEFORE this verification ran, so returning here without a derive leaves
      // toStore's projection stale — delivered-but-invisible messages, the very failure
      // the verified path guards against at :728-729. fromStore is deliberately NOT
      // derived: nothing has mutated it (its registry row is only tombstoned AFTER
      // verification succeeds). Best-effort + fail-open, mirroring the verified path.
      try { store.deriveSummary(toStore, { home, env: ctx && ctx.env }); } catch (_) {}
      return out;
    }

    // 4) Copy verified — tombstone ONLY the source-store registry row (message
    //    rows stay; append-only, dedup-safe), and only when the row actually came
    //    FROM the source store (a descriptor-only re-home has nothing to tombstone).
    //    Refresh both projections.
    if (regFromSource) { try { fromStore.removeRegistry(id); } catch (_) { /* tombstone best-effort; verified copy already durable */ } }
    try { store.deriveSummary(fromStore, { home, env: ctx && ctx.env }); } catch (_) {}
    try { store.deriveSummary(toStore, { home, env: ctx && ctx.env }); } catch (_) {}

    // 5) Rewrite the descriptor's persisted ownership so ensure stops rejecting.
    const desc = readDescriptorFile(home, id);
    if (desc && String(desc.id) === String(id)) {
      desc.ownerKey = toKey;
      if (descriptorFreshRepoKey(desc) === toKey) desc.repoKey = toKey;
      try { writeDescriptorAtomic(home, id, desc); } catch (_) { /* descriptor rewrite best-effort; store already re-homed */ }
    }
    out.rehomed = true;
    out.movedMessages = msgs.length;
    out.movedRegistry = regFromSource;
    return out;
  } catch (_) {
    return out; // fail-open: a re-home hiccup must never break the caller's verb
  } finally {
    if (fromStore) { try { fromStore.close(); } catch (_) {} }
    if (toStore) { try { toStore.close(); } catch (_) {} }
  }
}

// rehomeCore(home, id, repoKey, ctx) — the pre-existing legacy-hash-bucket ->
// repoKey re-home (P1-1/P1-2). Now a thin wrapper over the generalized
// rehomeAcrossStores: identical external behavior/signature (every existing
// caller/test is unaffected), source is always the legacy per-id hash bucket.
function rehomeCore(home, id, repoKey, ctx) {
  if (!repoKey) return { rehomed: false, movedMessages: 0, movedRegistry: false };
  return rehomeAcrossStores(home, id, store.hashFromWorkspaceId(id), repoKey, ctx);
}

// rehomeMiskeyedRow(home, id, storeRepoKey, ctx) — Claim 3 SELF-HEALING fix.
// The decision for ONE registry row currently living in store/<storeRepoKey>/:
// read its descriptor and compute a FRESH structural repoKey from the
// descriptor's OWN real worktreePath via descriptorFreshRepoKey — deliberately
// NOT descriptorStructuralRepoKey, which prefers a PERSISTED `desc.repoKey`
// field that can go stale relative to the worktree's actual, current git
// identity (e.g. a submodule split: the same worktreePath's git-common-dir
// changes without the descriptor's persisted ownerKey/repoKey being updated
// to match) — descriptorFreshRepoKey always re-derives from the live path, so
// this is the ONE independently-verifiable fact about "which project does
// this id's real worktree belong to today", ORTHOGONAL to whatever a stale
// registry worktree_path snapshot (what a reconcile-spawned subprocess's cwd
// is set from, defaultSpawnReconcile) or a stale persisted field might claim.
//
//   - freshRepoKey === storeRepoKey: the row IS correctly homed in the store
//     it is already sitting in — a prior false-negative here was purely a
//     stale-metadata artifact. Heal any stale persisted ownerKey/repoKey field
//     on the descriptor IN PLACE (no store move) so a later `ensure`
//     ownership check (cmdRegister) never mismatches on this id again.
//   - freshRepoKey resolves to a DIFFERENT, valid repoKey: the row is
//     genuinely mis-keyed — physically living in the WRONG store. REHOME it
//     via rehomeAcrossStores (message-preserving, merge-safe, no delete).
//   - freshRepoKey does not resolve at all (non-git cwd / vanished
//     worktree): leave the row exactly as-is — there is no independently
//     verifiable ground truth to correct it against.
//
// Runs under the per-id lock (serializes against a concurrent register/
// heartbeat/rehome for the same id) and is FAIL-OPEN throughout: any error
// leaves the row untouched; this function never throws, so a heal attempt
// can never break the caller (reconcile/doctor/update) it runs inside of.
// Idempotent: re-running against an already-healed/already-correct row is a
// no-op both times.
function rehomeMiskeyedRow(home, id, storeRepoKey, ctx) {
  const fallback = { id, rehomed: false, healedDescriptor: false, reason: null };
  if (!storeRepoKey || !id || !isSafeId(String(id))) return Object.assign({}, fallback, { reason: 'unsafe-or-missing-key' });
  try {
    return withIdLock(String(id), home, () => {
      const out = { id, rehomed: false, healedDescriptor: false, reason: null };
      const desc = readDescriptorFile(home, id);
      if (!desc || String(desc.id) !== String(id) || !desc.worktreePath) {
        out.reason = 'no-descriptor';
        return out;
      }
      // IDENTITY GUARD (P0 fix): the descriptor file is keyed by `id` ALONE and
      // can have been overwritten by a LATER, unrelated registration that reused
      // the same id (id collision / a stale row never cleaned up) — its
      // worktreePath/sessionId then belong to a DIFFERENT live session than the
      // row physically sitting in storeRepoKey today. Trusting that descriptor
      // as ground truth would rehome the OLD row's real content (its own
      // sessionId, its own messages) into the NEW session's store under the
      // shared id — a foreign-descriptor takeover of a legitimate row. Positively
      // confirm the row currently in storeRepoKey is still the SAME entity the
      // descriptor describes before acting on it: proceed ONLY when both sides
      // carry a live (non-null, non-empty) sessionId AND they positively agree
      // — the one case independently verifiable as "same entity, stale
      // metadata". A null/empty sessionId on EITHER side is never a wildcard
      // match (P1 fix): e.g. curRow {sessionId:null} vs a foreign desc
      // {sessionId:'foreign-session'} must never fall through as "unconfirmed,
      // proceed" — that would silently accept a genuinely foreign descriptor
      // and steal/misroute the row's real content. Anything short of a
      // confirmed positive match — either side null/empty, or a straight
      // mismatch — refuses (fail-open, no-op) rather than move/overwrite.
      let curRow = null;
      try {
        const cs = store.openStore({ home, hash: storeRepoKey, backend: ctx && ctx.backend, env: ctx && ctx.env });
        try { curRow = (cs.listRegistry() || []).find((r) => r && String(r.id) === String(id)) || null; }
        finally { try { cs.close(); } catch (_) {} }
      } catch (_) { curRow = null; }
      if (curRow) {
        const curSid = isLiveSessionId(curRow.sessionId) ? String(curRow.sessionId) : null;
        const descSid = isLiveSessionId(desc.sessionId) ? String(desc.sessionId) : null;
        const confirmedMatch = curSid !== null && descSid !== null && curSid === descSid;
        if (!confirmedMatch) {
          out.reason = 'descriptor-identity-mismatch';
          return out;
        }
      }
      const freshRepoKey = descriptorFreshRepoKey(desc);
      if (!freshRepoKey) { out.reason = 'unresolvable'; return out; }
      if (freshRepoKey === storeRepoKey) {
        const storedOwnerKey = typeof desc.ownerKey === 'string' && desc.ownerKey ? desc.ownerKey : null;
        const storedRepoKey = typeof desc.repoKey === 'string' && desc.repoKey ? desc.repoKey : null;
        if (storedOwnerKey !== storeRepoKey || storedRepoKey !== storeRepoKey) {
          const healedDesc = Object.assign({}, desc, { ownerKey: storeRepoKey, repoKey: storeRepoKey });
          try { writeDescriptorAtomic(home, id, healedDesc); out.healedDescriptor = true; }
          catch (_) { out.reason = 'descriptor-write-failed'; }
        }
        // ALSO heal a stale REGISTRY worktree_path: the row physically sitting
        // in THIS store must reflect the descriptor's real, current
        // worktreePath — otherwise a reconcile-spawned subprocess's cwd (set
        // from the registry row, defaultSpawnReconcile) keeps using the stale
        // path forever, re-triggering the exact false-negative this heal
        // exists to prevent, on every single reconcile run. We have already
        // independently verified (via the descriptor, the per-id authoritative
        // record) that `id` genuinely belongs here — the SAME "known,
        // intentional same-id path change, not a hash collision" posture
        // rekeySubdirRegistryRows already uses `allowPathChange:true` for.
        let s = null;
        try {
          s = store.openStore({ home, hash: storeRepoKey, backend: ctx && ctx.backend, env: ctx && ctx.env });
          const row = (s.listRegistry() || []).find((r) => r && String(r.id) === String(id)) || null;
          if (row && row.worktreePath !== desc.worktreePath) {
            const fixedRow = Object.assign({}, row, { worktreePath: desc.worktreePath });
            const written = s.upsertRegistry(fixedRow, { allowPathChange: true });
            if (written) {
              out.healedRegistryPath = true;
              try { store.deriveSummary(s, { home, env: ctx && ctx.env }); } catch (_) {}
            }
          }
        } catch (_) { /* best-effort: descriptor healing above already landed */ }
        finally { if (s) { try { s.close(); } catch (_) {} } }
        return out;
      }
      // Genuinely mis-keyed: physically living in storeRepoKey's store, but the
      // descriptor's own real worktreePath structurally belongs to
      // freshRepoKey instead.
      //
      // FIRST-PASS DETERMINISM (P0 self-heal reliability). The row physically in
      // storeRepoKey may carry a STALE worktree_path SNAPSHOT — an older path the
      // registry captured before the worktree moved / was re-derived — while the
      // descriptor (the per-id authoritative record we JUST identity-confirmed
      // via the sessionId positive match above) carries the real, CURRENT
      // worktreePath. rehomeAcrossStores rebuilds the destination row FROM the
      // source registry row, so it would carry that stale path forward. When a
      // CANONICAL copy already sits in freshRepoKey's store holding the current
      // path, the destination's F2 id-collision guard then refuses the upsert
      // (stale != current, non-null) and the whole re-home fails its regPresent
      // verification — surfaced as regConflict today, and as the literal
      // reason:'rehome-not-applied' in the pre-F-D code (the shape observed live:
      // a legacy bare-hash stray with the canonical copy already in the named
      // store, rehoming only AFTER an unrelated metadata upsert happened to
      // rewrite the stale path). The redundant stray is otherwise LEFT stranded
      // on EVERY heal pass, converging only by external side-effect — not the
      // deterministic single automatic pass self-heal promises.
      //
      // Normalize the source row's worktree_path to the descriptor's verified
      // current path FIRST (allowPathChange:true — the SAME "known, intentional
      // same-id path change, not a hash collision" opt-in the freshRepoKey ===
      // storeRepoKey branch above already uses, justified identically: the
      // descriptor has independently confirmed this id's entity belongs here),
      // so rehomeAcrossStores builds the destination row with the current path,
      // matches the canonical copy, and converges in THIS single pass. No-delete
      // (only an in-place path refresh on a row about to be tombstoned anyway),
      // idempotent (a row already carrying the current path is untouched), and
      // fail-open (any error just falls through to the pre-fix behavior).
      try {
        const ns = store.openStore({ home, hash: storeRepoKey, backend: ctx && ctx.backend, env: ctx && ctx.env });
        try {
          const srow = (ns.listRegistry() || []).find((r) => r && String(r.id) === String(id)) || null;
          if (srow && srow.worktreePath !== desc.worktreePath) {
            ns.upsertRegistry(Object.assign({}, srow, { worktreePath: desc.worktreePath }), { allowPathChange: true });
          }
        } finally { try { ns.close(); } catch (_) {} }
      } catch (_) { /* best-effort: rehomeAcrossStores still runs; a stale path only risks the pre-fix regConflict */ }
      const r = rehomeAcrossStores(home, id, storeRepoKey, freshRepoKey, ctx);
      out.rehomed = !!r.rehomed;
      out.movedMessages = r.movedMessages || 0;
      out.movedRegistry = !!r.movedRegistry;
      if (r.regConflict) out.regConflict = true;
      if (!r.rehomed && !r.regConflict) out.reason = 'rehome-not-applied';
      return out;
    });
  } catch (_) {
    return Object.assign({}, fallback, { reason: 'heal-error' }); // fail-open: a heal hiccup must never break the caller
  }
}

// healRegistry(home, repoKey, ctx) — Claim 3 (d): the ONE exported sweep
// `doctor`, `update.js`'s repair pass, and `cmdReconcile`'s own self-heal
// pre-pass all share: runs rehomeMiskeyedRow over EVERY row currently in
// store/<repoKey>/'s registry. FAIL-OPEN per row (one row's error never
// aborts the sweep) and idempotent (a second run over an already-healed
// registry heals/rehomes nothing further — every row that needed correcting
// on the first pass already agrees with a fresh recompute on the second).
function healRegistry(home, repoKey, ctx) {
  const out = { repoKey, checked: 0, healed: 0, rehomed: 0, skipped: 0, rows: [] };
  if (!repoKey) return out;
  let rows = [];
  try {
    const s = store.openStore({ home, hash: repoKey, backend: ctx && ctx.backend, env: ctx && ctx.env });
    try { rows = s.listRegistry() || []; } finally { s.close(); }
  } catch (_) { rows = []; }
  for (const row of rows) {
    if (!row || row.id == null || !isSafeId(String(row.id))) { out.skipped++; continue; }
    out.checked++;
    let r;
    try { r = rehomeMiskeyedRow(home, String(row.id), repoKey, ctx); }
    catch (_) { r = { id: row.id, rehomed: false, healedDescriptor: false, reason: 'heal-error' }; }
    if (r.rehomed) out.rehomed++;
    else if (r.healedDescriptor || r.healedRegistryPath) out.healed++;
    else out.skipped++;
    out.rows.push(r);
  }
  return out;
}

// maybeRehomeToCwdProject(home, id, ctx) — the descriptor-signalled trigger: if
// the CURRENT cwd resolves a repoKey AND the on-disk descriptor's persisted
// ownerKey equals the legacy hash bucket key (the split-brain marker), re-home
// under the per-id lock. Returns the rehomeCore result, or null when no re-home
// applies. Shared by the ensure/read paths.
function maybeRehomeToCwdProject(home, id, ctx) {
  const repoKey = repoKeyForCwd(ctx);
  if (!repoKey) return null;
  const hashKey = store.hashFromWorkspaceId(id);
  if (!hashKey || hashKey === repoKey) return null;
  const desc = readDescriptorFile(home, id);
  const storedOwnerKey = desc && typeof desc.ownerKey === 'string' && desc.ownerKey ? desc.ownerKey : null;
  if (storedOwnerKey !== hashKey) return null; // not stranded in the hash bucket
  const r = withIdLock(id, home, () => rehomeCore(home, id, repoKey, ctx));
  // withIdLock now fails closed (G1): a lock-busy return is NOT a re-home result
  // — normalize to null so callers' `rh && rh.rehomed` guard reads it as "no
  // re-home this call" (the read/send/gate path fail-opens and retries later).
  return (r && r.lockBusy) ? null : r;
}

// isForwardable(msg) — retire-forward NOISE FILTER (#67). retireWorktreeDuplicates
// re-appends a duplicate partition's unread backlog into the survivor as fresh
// directs; forward ONLY a REAL actionable direct. Native ingest
// (devswarm-ingest.js / devswarm-pull.js) writes body+hash ONLY, so a stale
// `[Primary poke]` mirror or a `{_h:"native:..."}` hash-mirror row reads back as
// mtype:null / sender:null — forwarding those resurrects dead pokes into the live
// partition (proven harmful on a real store). A forwardable row must be a real
// mesh direct: mtype==='direct' (one check that excludes broadcast, heartbeat, AND
// every null-mtype native/poke/hash-mirror row) with a non-empty sender AND
// recipient. A legitimately-forwarded direct (appendMeshMessage sets all three)
// still passes, so real traffic is never over-filtered. This structural rule
// now lives in companion/lib/devswarm-noise.js (isForwardableRow) purely so
// it can be extracted and re-tested in one place — it is otherwise VERBATIM
// unchanged from the original #67 check and is deliberately NOT body-text
// filtered (see that module's own comment). devswarm-parent-gate.js's
// realUnread count applies the SEPARATE POKE_PREFIX text check (isNoiseText)
// to a DIFFERENT row shape (descriptor durable-inbox NDJSON, no
// mtype/sender/recipient at all, so it has no structural signal to use
// instead) — the two checks share only the POKE_PREFIX constant, not this
// structural rule.
function isForwardable(msg) {
  return isForwardableRow(msg);
}

// retireWorktreeDuplicates(home, keepDesc, ctx) — DELIVERY-CONVERGENCE reconcile
// (v0.55.x P0 message-loss fix). A DevSwarm child registers under its builder-id
// (the per-project substrate scheme — a free-form id that is NOT the worktree's own
// meshId). An OLDER duplicate row for the SAME worktree can still be LIVE in the
// shared registry: a legacy hivecontrol-native `<label>-<repoId8>` registration, or
// a pre-register `primary-<hash>` spawn phantom. Both hash (via their worktreePath)
// to the SAME meshId as the child's own row, so `resolveMeshTarget` has TWO rows
// resolving to this worktree and can route a `send` into the duplicate's partition —
// which no live session ever drains (the child reads its OWN builder-id partition)
// -> silent message loss.
//
// On self-register this RETIREs every OTHER same-worktree row so exactly ONE row
// (the caller's own builder-id — the partition the child actually reads) survives,
// making send-target and child-drain CONVERGE on ONE partition. Retire = the
// sanctioned registry tombstone (store.removeRegistry — a `remove` op in the
// append-only journal, a registry-row delete in sqlite); the `messages` rows are a
// DIFFERENT table and are NEVER deleted. Before tombstoning, every UNREAD direct
// message already sitting in the retired partition is FORWARDED into the surviving
// partition (re-appended with the survivor as recipient, hash recomputed from the
// new fields so a re-run OR-IGNOREs) so the cutover — and the entire backlog a child
// silently lost while both rows were live — orphans NOTHING. If forwarding a row's
// backlog throws, that duplicate is LEFT in place (never tombstoned) so no unread is
// stranded; a later self-register retries it.
//
// GATED to builder-id self-registrations (keepDesc.id !== the worktree's meshId): a
// meshId-keyed register (the Primary's `register-primary`, or the spawn phantom) must
// NEVER retire the child's live builder-id row, so those paths are a deliberate
// no-op. Idempotent (a tombstoned row is gone from listRegistry, so a re-run finds
// nothing) and FAIL-OPEN (any error is swallowed — a reconcile failure must never
// crash the child's register / SessionStart or block its turn).
function retireWorktreeDuplicates(home, keepDesc, ctx) {
  try {
    if (!keepDesc || !keepDesc.worktreePath || !keepDesc.id) return null;
    const keepMesh = inst.primaryWorkspaceId(keepDesc.worktreePath);
    if (!keepMesh) return null;
    // A meshId-keyed row (Primary / spawn phantom) must not retire a child's live
    // builder-id row — only a builder-id self-register (id !== the worktree meshId)
    // is the NEW scheme this reconcile is for.
    if (String(keepDesc.id) === String(keepMesh)) return null;
    // P1 (mis-retire hardening): match same-worktree candidates by the CANONICAL
    // real-path (worktreeRealPath — the collision-free pre-image of the hash), NOT
    // the 8-hex worktreeHash/meshId. A sha256-slice hash can (astronomically, but on
    // a money path "can" is disqualifying) collide two DISTINCT worktrees onto one
    // meshId; matching the resolved real path instead makes a mis-identification
    // impossible. The SHARED canonicalWorktreeRealPath (also used by
    // foldMeshDuplicates) is the collision-free pre-image of canonicalMeshId's hash,
    // so the two paths cannot diverge. Fail-open null (unresolvable) -> no-op.
    const keepReal = canonicalWorktreeRealPath(keepDesc.worktreePath);
    if (!keepReal) return null;
    const repoKey = repoKeyForCwd(ctx);
    const s = store.openStore({
      home, workspaceId: keepDesc.id, hash: repoKey || undefined,
      backend: ctx && ctx.backend, env: ctx && ctx.env,
    });
    let result;
    try {
      // Candidate set = every OTHER registry row for the SAME physical worktree
      // (matched by the SHARED canonicalWorktreeRealPath — the collision-free
      // pre-image of the hash, NOT the 8-hex meshId, so a sha256-slice hash can
      // never mis-identify two DISTINCT worktrees onto one meshId; fail-open null
      // -> this row is skipped). The forward-then-tombstone body is the SHARED
      // foldGroupIntoSurvivor primitive (also used by foldMeshDuplicates).
      const candidates = [];
      for (const d of s.listRegistry()) {
        if (!d || d.id == null || String(d.id) === String(keepDesc.id)) continue;
        if (!d.worktreePath) continue;
        if (canonicalWorktreeRealPath(d.worktreePath) !== keepReal) continue; // SAME physical worktree only (no hash-collision class)
        candidates.push(d);
      }
      result = foldGroupIntoSurvivor(s, home, keepDesc.id, candidates);
      // Gate on forwarded TOO, not retired alone: foldGroupIntoSurvivor forwards unread
      // rows into the survivor partition (devswarm.js:1124) BEFORE the descriptor check
      // (:1136) that classifies a candidate as `left`. When every candidate is
      // descriptor-backed, forwarded>0 with retired EMPTY — real messages delivered with
      // NO projection refresh, so they are invisible to every summary.json reader.
      if (result.retired.length || result.forwarded) store.deriveSummary(s, { home, env: ctx && ctx.env });
    } finally { s.close(); }
    const { retired, left, forwardFailed, forwarded } = result;
    if (!retired.length && !left.length && !forwarded && !forwardFailed.length) return null;
    const out = { retired, forwarded };
    if (left.length) out.left = left;
    if (forwardFailed.length) out.forwardFailed = forwardFailed;
    return out;
  } catch (_) { return null; } // fail-open: reconcile must never crash the caller
}

// foldGroupIntoSurvivor(s, home, survivorId, candidates, opts) — the SHARED
// forward-then-tombstone primitive used by BOTH retireWorktreeDuplicates (one
// caller's worktree) and foldMeshDuplicates (the whole registry). For each
// candidate row (already filtered to belong with `survivorId`):
//   1. FORWARD its UNREAD direct backlog into the survivor (re-appended with the
//      survivor as recipient, hash recomputed so a re-run OR-IGNOREs), so the
//      cutover orphans NOTHING. Best-effort per row: on ANY forward error, DO NOT
//      tombstone — the row is LEFT (recorded in forwardFailed + a stderr warning,
//      never silently swallowed) so no unread is stranded (a later pass retries).
//   2. TOMBSTONE only a row we can prove is NOT a distinct live child — a
//      store-only row (spawn phantom / ingested legacy hivecontrol-native
//      registration) with NO on-disk per-project descriptor. A candidate that HAS
//      a descriptor could be a distinct live child draining its OWN partition, so
//      it is LEFT (recorded in `left`), never tombstoned — losing a message by
//      mis-retiring is far worse than leaving a duplicate row (P1 hardening).
// `opts.dryRun` classifies (which rows WOULD retire/left) without forwarding or
// tombstoning — used by the doctor `fold-mesh-duplicates` detect() so it shares
// this ONE classification instead of a second reimplementation. NEVER throws on a
// row (each is try/wrapped by the caller's own fold body / fail-open).
//
// `opts.lockCandidates` (OPT-IN — the ARCHIVE paths only; see
// retireArchivedWorktreeGroup's header for the full why) runs each candidate's
// forward + descriptor-check + conditional tombstone under withIdLock(candidateId)
// and re-derives the CAS snapshot from a FRESH in-lock re-read of that row. The
// conditional tombstone alone closes every interleaving where a candidate's
// re-register lands BEFORE the tombstone (the CAS then mismatches and refuses);
// it CANNOT close the one where the re-register's registry write lands AFTER it —
// cmdRegister writes the descriptor and upserts the row as two separate steps, so
// a fold that samples the row, sees no descriptor yet, and CASes before either
// write tombstones a row that a live child is in the middle of re-establishing.
// Holding that candidate's OWN lock makes our check+tombstone atomic with respect
// to cmdRegister, which wraps both of its writes in withIdLock(id) — the window
// closes completely. A lock-busy candidate is SKIPPED (never forwarded, never
// tombstoned), reported in `lockBusy`, and retried by a later pass (every step
// here is idempotent). Existing non-archive callers do not pass this and keep
// today's exact behaviour.
function foldGroupIntoSurvivor(s, home, survivorId, candidates, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const lockCandidates = !!(opts && opts.lockCandidates) && !dryRun;
  const retired = [];
  const left = [];
  const forwardFailed = [];
  // `skipped` — candidates we deliberately did NOT act on this pass (lockCandidates
  // only): [{id, reason}] with reason 'lock-busy' | 'row-unreadable'. Always present
  // and EMPTY for the unlocked callers, whose behaviour is unchanged.
  const skipped = [];
  // `leftRows` — id -> the row this pass ACTUALLY judged when it decided 'left'
  // (the fresh in-lock re-read when lockCandidates is on, the pre-lock row
  // otherwise). Callers that report WHY a row was left (archiveLeftReason) must
  // key off this, not their own pre-lock snapshot, or the reported reason can
  // contradict what the pass acted on for a row whose liveness changed inside
  // the lock window. `left` itself stays a plain id array — existing callers
  // (foldMeshDuplicates) read it that way and are unaffected.
  const leftRows = new Map();
  let forwarded = 0;
  for (const d of candidates) {
    if (!d || d.id == null || String(d.id) === String(survivorId)) continue;
    if (dryRun) {
      // read-only classification: a store-only row WOULD be tombstoned; a
      // descriptor-backed one WOULD be left (never collapsed).
      if (readDescriptorFile(home, d.id)) { left.push(d.id); leftRows.set(String(d.id), d); continue; }
      retired.push(d.id);
      continue;
    }
    // foldOne(row) — the per-candidate forward-then-tombstone body, factored so it
    // can run either UNLOCKED (the pre-existing callers' byte-identical behaviour)
    // or inside withIdLock(row.id) when lockCandidates is on. `row` is the snapshot
    // the conditional tombstone is keyed on: the pre-lock listRegistry() row when
    // unlocked, or a FRESH in-lock re-read when locked (acting on a pre-lock
    // snapshot under a lock would re-introduce the very lost-update the lock is
    // taken to prevent — rekeySubdirRegistryRows' rule).
    const foldOne = (row) => {
      let forwardOk = true;
      try {
        const since = s.cursorValue(row.id);
        for (const m of s.listMessages(row.id, { sinceCursor: since })) {
          if (!isForwardable(m)) continue; // #67: forward only a real actionable direct — skips broadcast/heartbeat AND stale native poke/hash-mirror rows (mtype/sender null)
          // FORWARD: same ONE shared MESH_ROW_COPY_FIELDS table as the verbatim
          // re-home site (see meshRowCopy). The overrides re-address the copy to the
          // survivor partition; `type:'direct'` is pinned (not m.mtype) because only
          // a direct can reach here at all — isForwardable already filtered the rest —
          // and urgency keeps its pre-existing empty-string->'normal' normalization.
          // `hash` is absent by design (recomputed below from the NEW fields) and so
          // is `isHeartbeat` (a heartbeat is never forwardable).
          const fields = meshRowCopy(m, 'message', {
            to: survivorId, type: 'direct', urgency: m.urgency || 'normal',
          });
          const hash = store.meshMessageHash(fields);
          const r = store.appendMeshMessage(s, Object.assign({}, fields, { hash }));
          if (r && r.inserted) forwarded++;
        }
      } catch (_) { forwardOk = false; }
      if (!forwardOk) return { outcome: 'forward-failed' };
      // `row` here is whatever foldOne was called with — the in-lock re-read `cur`
      // when locked, the pre-lock candidate `d` when not — so a caller keying its
      // reported reason off this row (leftRows, below) reports what THIS pass
      // actually judged, not a possibly-stale pre-lock snapshot.
      if (readDescriptorFile(home, row.id)) return { outcome: 'left', row };
      // P1a/P2/P3 race close: ATOMIC conditional tombstone. removeRegistryIf deletes
      // ONLY if the row is STILL EXACTLY the one we classified — its session_id AND
      // updatedAt AND writeSeq all still equal our snapshot (NULL-safe, so a null
      // snapshot updatedAt/writeSeq that gained a real value, or a NEW session_id,
      // counts as a re-register). sqlite: one atomic DELETE ... WHERE; journal: an
      // under-lock re-read + a conditional (`ifUpdatedAt`/`ifSessionId`/`ifWriteSeq`)
      // remove op reduceRegistry ignores if a re-register raced it. A child that
      // re-registered in the window (child-turn writes its descriptor THEN its store
      // row) is now re-written -> NOT deleted -> LEFT (a later fold re-evaluates);
      // forward-before-tombstone already ran and is idempotent, so nothing is
      // orphaned. (Descriptor-backed rows were already LEFT above — this pins the
      // store-only phantom, which may itself carry a stale session_id.)
      // P3 (v0.61.0 money-path residual): writeSeq is a per-row monotonic counter
      // bumped on EVERY upsert regardless of wall-clock ms — closes the LAST gap
      // where a live child re-registers the SAME id/sessionId within the SAME
      // millisecond as the snapshot (updatedAt alone can't distinguish that from a
      // stable phantom; writeSeq still advances).
      const removed = s.removeRegistryIf(row.id, { sessionId: row.sessionId, updatedAt: row.updatedAt, writeSeq: row.writeSeq });
      if (!removed) return { outcome: 'left' };
      return { outcome: 'retired' };
    };

    let res;
    if (lockCandidates) {
      // NEVER the survivor's own lock — only CANDIDATE ids, which the loop guard
      // above proves are != survivorId. The archive callers already hold the
      // survivor's lock, so re-acquiring it here would self-deadlock.
      const r = withIdLock(d.id, home, () => {
        let cur = null;
        try { cur = (s.listRegistry() || []).find((x) => x && x.id != null && String(x.id) === String(d.id)) || null; }
        catch (_) { return { outcome: 'unreadable' }; }
        if (!cur) return { outcome: 'gone' }; // row already retired by another op -> nothing to do
        return foldOne(cur);
      });
      if (r && r.lockBusy) {
        // SKIPPED, not forwarded and not tombstoned: another operation (typically
        // the candidate's own cmdRegister) holds its lock. Surfaced, never silently
        // dropped — every step here is idempotent, so a later pass retires it.
        skipped.push({ id: String(d.id), reason: 'lock-busy' });
        try {
          process.stderr.write('[devswarm] foldGroupIntoSurvivor: candidate ' + JSON.stringify(String(d.id))
            + ' is locked by another operation in progress — skipped this pass (retried on the next run)\n');
        } catch (_) {}
        continue;
      }
      res = r;
    } else {
      res = foldOne(d);
    }
    if (!res || res.outcome === 'gone') continue;
    if (res.outcome === 'unreadable') {
      // Could not re-read the row under its lock -> cannot classify it; leave it
      // exactly as it is (idempotent retry next pass) rather than acting blind.
      skipped.push({ id: String(d.id), reason: 'row-unreadable' });
      continue;
    }
    if (res.outcome === 'forward-failed') {
      forwardFailed.push(String(d.id));
      try {
        process.stderr.write('[devswarm] foldGroupIntoSurvivor: forward FAILED for '
          + String(d.id) + ' — row LEFT in place (not tombstoned); fold incomplete\n');
      } catch (_) {}
      continue;
    }
    if (res.outcome === 'left') {
      left.push(d.id);
      leftRows.set(String(d.id), res.row || d);
      continue;
    }
    retired.push(d.id);
  }
  return { retired, left, forwardFailed, forwarded, skipped, leftRows };
}

// pickArchiveForwardSurvivor(s, home, archivedId, rows) — WHERE the archive folds
// forward the unread backlog. This is a SEPARATE question from WHAT gets retired,
// and getting it wrong is message LOSS, not merely untidy bookkeeping.
//
// The archive paths originally hardcoded the ARCHIVED id as the forward survivor.
// That is right only when the whole worktree is going away. It is WRONG whenever a
// DIFFERENT live workspace still holds this worktree, because of the exact ordering
// the archive performs: forward into <survivor>, then tombstone. When the survivor
// IS the id being archived, its own registry row is tombstoned moments later
// (cmdArchive's removeRegistry, or this migration's ownRow CAS) — so a real unread
// direct, forwarded a few lines earlier, lands in a partition that computeSummary
// no longer projects and that NO live session drains. It is not deleted (message
// rows never are), but it is unreachable and invisible: the v0.55.x P0 message-loss
// class, re-created by the fold that was supposed to prevent it. A phantom row's
// unanswered question belongs with whoever is still ALIVE on that worktree.
//
// RULE: forward to a same-worktree row that has BOTH its OWN live descriptor
// (workspaces/<id>.json) AND a LIVE registry sessionId (isLiveSessionId). Among
// several such rows, defer to the EXISTING pickSurvivor (freshest-live registry
// updatedAt, cursor tiebreak) — the same selection resolveMeshTarget and
// foldMeshDuplicates already use, so a `send` to this worktree and this forward
// converge on ONE partition rather than a second, divergent survivor policy. With NO
// such row the archived id is the survivor: legitimate, because the whole worktree is
// retiring and the resulting partition is SURFACED as an orphan (never deleted),
// which is the no-delete posture, not loss.
//
// CONSERVATIVE vs STRICT — the conceptual error the first version of this helper
// made, spelled out because it reads like a consistency win and is not:
// that version deliberately reused the TOMBSTONE safety gate's test (descriptor
// presence, and nothing else) for the forward destination, on the reasoning that "the
// row we refuse to retire" and "the row we trust to drain" must never disagree. They
// are DIFFERENT QUESTIONS and they SHOULD disagree:
//   - TOMBSTONING must be CONSERVATIVE: never retire a row that MIGHT still be alive.
//     A descriptor file is the right (permissive) test there — over-keeping a row is
//     untidy, mis-retiring one loses a workspace. That gate is UNCHANGED.
//   - The FORWARD DESTINATION must be STRICT: only forward where something will
//     ACTUALLY drain. A descriptor file proves only that a workspace once existed —
//     NOTHING purges a stale workspaces/<id>.json after a crash, so a crashed sibling
//     keeps its descriptor while its registry sessionId is empty/synthetic (dead).
// Forwarding into such a row buries a real unanswered direct in a partition no live
// session drains: the SAME message-loss class this helper exists to close, merely
// relocated from the archived id to a different dead id — and WORSE, because the
// destination was then reported as 'live-descriptor', so the operator had no signal
// anything was wrong. Session liveness is the only test that answers "will this
// drain?".
//
// pickSurvivor's firstMatch fallback is why the filter must be a PRE-filter, not a
// post-hoc trust: pickSurvivor assigns firstMatch UNCONDITIONALLY before its own
// liveness check and ends `return bestLive || firstMatch`, so handing it a set with
// no live row returns a DEAD row rather than null. Every row we pass in is therefore
// already proven live-session, which makes both branches of that fallback live; the
// belt-and-braces post-check below re-verifies the pick and falls back to the
// archived id if it is ever not. pickSurvivor itself is left alone on purpose — its
// other callers (retireWorktreeDuplicates / foldMeshDuplicates / the fold) rely on
// the firstMatch fallback, and changing shared behaviour here would be a far wider
// blast radius than this bug.
//
// Fail-open: any error -> the archived id (the pre-existing behaviour).
function pickArchiveForwardSurvivor(s, home, archivedId, rows) {
  try {
    const drainableRows = [];
    for (const d of rows || []) {
      if (!d || d.id == null || String(d.id) === String(archivedId)) continue;
      if (!readDescriptorFile(home, d.id)) continue;   // store-only phantom: cannot drain anything
      if (!isLiveSessionId(d.sessionId)) continue;     // descriptor-backed but SESSION-DEAD (crashed sibling): nothing drains it
      drainableRows.push(d);
    }
    if (!drainableRows.length) return String(archivedId);
    const pick = pickSurvivor(s, { rows: drainableRows });
    // Post-check (defence in depth against pickSurvivor's firstMatch fallback ever
    // returning a row the pre-filter would have rejected): a destination we cannot
    // PROVE drainable is never used.
    if (!pick || pick.id == null || !isLiveSessionId(pick.sessionId) || !readDescriptorFile(home, pick.id)) {
      return String(archivedId);
    }
    return String(pick.id);
  } catch (_) { return String(archivedId); }
}

// archiveLeftReason(home, id, row) — the REPORTED reason a same-worktree row survived
// the fold. Must be a FACT, not a reassuring label: the tombstone gate keeps every
// descriptor-backed row (correctly conservative — see above), so a row left behind may
// be a genuinely live child OR a crashed one whose stale descriptor outlived it. Those
// are operationally different (the first drains its partition, the second does not), so
// they get DIFFERENT reasons — 'live-descriptor' keeps its existing, accurate meaning
// (descriptor AND live session; other tests assert on it) and the dead case is named
// explicitly instead of borrowing the word "live". `row` is the registry snapshot, may
// be missing -> then only the descriptor is knowable.
function archiveLeftReason(home, id, row) {
  if (!readDescriptorFile(home, id)) return 'raced-re-register';
  if (row && isLiveSessionId(row.sessionId)) return 'live-descriptor';
  if (!row) return 'live-descriptor'; // no snapshot to judge liveness with; descriptor is all we know
  return 'descriptor-no-live-session';
}

// retireArchivedWorktreeGroup(s, home, archivedId, worktreePath) — the ARCHIVE
// counterpart of retireWorktreeDuplicates, and the fix for "an archived
// workspace keeps projecting ACTIVE on the roster".
//
// MECHANISM (why one tombstone is not enough): a registry row is keyed on the
// id of whoever REGISTERED it (cmdRegister), while a worktree's mesh ADDRESS is
// derived separately from its worktreePath. Two id-spaces, one worktree — by
// design (a child MUST own the partition it drains, the v0.55.x P0 message-loss
// fix). The consequence is that up to four DIFFERENT ids can hold a live
// registry row for ONE physical worktree at the same time: the child's
// hivecontrol builder UUID, a `primary-<8hex>` spawn phantom / register-primary
// row, a legacy ingested `<label>-<repoId8>` row, and a `primary-<8hex>`
// derived from a SUBDIR pre-image. cmdArchive tombstoned exactly ONE of them —
// the id it was asked to archive — and computeSummary treats "has a registry
// row" as "this workspace is active", so EVERY surviving sibling row kept the
// just-archived workspace projecting as live. Archiving is a WORKTREE-level
// retirement, so the whole same-worktree group must retire with it.
//
// Candidates are matched on the collision-free canonicalWorktreeRealPath (the
// resolved real path STRING, never the 8-hex hash — a hash bucket can collide
// two distinct worktrees; see that helper's own comment), and folded with the
// SHARED foldGroupIntoSurvivor primitive, so every retired row's unread direct
// backlog is FORWARDED into ONE partition before anything is tombstoned. Message
// rows are NEVER deleted.
//
// The forward survivor is chosen by LIVENESS (pickArchiveForwardSurvivor), NOT by
// "whoever is being archived". Hardcoding the archived id forwards a phantom's
// unanswered question into a partition this very function's caller tombstones a few
// lines later — undeleted but undrainable and unprojected, i.e. the message-loss
// class the fold exists to prevent. See that helper for the full why. The survivor
// is never a candidate (so it is never locked, forwarded from, or tombstoned) and,
// when it is not the archived id, it is still SURFACED in `left` with its
// 'live-descriptor' reason — it survived the fold, and every surviving
// same-worktree row is reported.
//
// SAFETY GATE (the sharpest edge): foldGroupIntoSurvivor deliberately LEAVES any
// row that has its own LIVE descriptor (workspaces/<id>.json) — such a row could
// be a DISTINCT live child draining its own partition, and tombstoning it would
// silently archive a workspace the user never asked to archive. That is exactly
// the rule archive needs, so it is reused verbatim rather than relaxed: a row is
// tombstoned only when it has no live descriptor of its own. Every row left
// behind is SURFACED with a reason (never silently dropped), so the caller can
// report it instead of the user discovering a still-active ghost later.
//
// LOCKING (this used to read "lock-free BY CONTRACT" — that was WRONG for this
// path, and the reason is worth spelling out):
//   - The ARCHIVED id is NEVER locked here. cmdArchive already holds
//     withIdLock(archivedId) around this whole call, and the per-id lock is NOT
//     re-entrant, so re-acquiring it would self-deadlock (it would spin out its
//     budget and then fail closed, silently turning archive into a no-op fold).
//     Every candidate is != archivedId by the loop's own guard, so nothing below
//     can ever take that lock.
//   - The CANDIDATES *are* locked (`lockCandidates: true`), because the atomic
//     conditional tombstone is not sufficient on its own. removeRegistryIf refuses
//     when a candidate's re-register lands BEFORE it (the snapshot mismatches), but
//     cmdRegister performs TWO writes — descriptor first, registry upsert second —
//     both under withIdLock(id). A fold that samples a candidate's row, reads no
//     descriptor (not written yet), and CASes (row not yet re-upserted, so the
//     snapshot still matches) tombstones the row of a child that is at that instant
//     coming back to life; the child's upsert then re-creates the row, leaving the
//     unread backlog we just forwarded sitting as undrainable duplicates in the
//     ARCHIVED partition (whose own registry row cmdArchive tombstones moments
//     later) and, in the window between, a live child that `send` and the roster
//     both read as unregistered. Taking the candidate's OWN lock makes our
//     descriptor-check + tombstone atomic against exactly those two writes, which
//     is what closes the window. The in-lock re-read (never the pre-lock snapshot)
//     is what makes the CAS key honest.
//   - NO CYCLE: withIdLock is a BOUNDED wait (acquireIdLock's 2s budget) that then
//     FAILS CLOSED with {lockBusy:true} rather than blocking forever, and a
//     lock-busy candidate is SKIPPED — not forwarded, not tombstoned, just
//     surfaced in `left` with reason 'lock-busy'. So two concurrent archives on one
//     worktree that each hold the other's id (an X->Y / Y->X cycle) cannot wedge:
//     both time out, both skip, and because every step is idempotent a later pass
//     retires whatever was skipped.
// FAIL-OPEN: never throws.
function retireArchivedWorktreeGroup(s, home, archivedId, worktreePath) {
  const out = { retired: [], forwarded: 0, left: [], forwardedTo: String(archivedId) };
  try {
    if (!worktreePath || archivedId == null) return out;
    const keepReal = canonicalWorktreeRealPath(worktreePath);
    if (!keepReal) return out; // unresolvable path -> cannot PROVE same worktree; never fold
    const candidates = [];
    for (const d of s.listRegistry()) {
      if (!d || d.id == null || String(d.id) === String(archivedId)) continue;
      if (!d.worktreePath) continue;
      if (canonicalWorktreeRealPath(d.worktreePath) !== keepReal) continue; // SAME physical worktree only
      candidates.push(d);
    }
    if (!candidates.length) return out;
    // LIVENESS survivor: a same-worktree row that still has its own descriptor
    // outlives this archive, so it — not the id being tombstoned — is the partition
    // the phantoms' unread must land in.
    const survivorId = pickArchiveForwardSurvivor(s, home, archivedId, candidates);
    out.forwardedTo = survivorId;
    // The survivor is excluded from the fold entirely: never forwarded FROM, never
    // locked, never tombstoned. (foldGroupIntoSurvivor's own loop guard would skip
    // it anyway; filtering here makes the exclusion explicit and keeps it out of the
    // primitive's retired/left bookkeeping so we can report it ourselves.)
    const foldCandidates = candidates.filter((d) => d && String(d.id) !== survivorId);
    const r = foldGroupIntoSurvivor(s, home, survivorId, foldCandidates, { lockCandidates: true });
    out.retired = r.retired.map((x) => String(x));
    out.forwarded = r.forwarded;
    // The forward survivor, when it is not the archived id, is a same-worktree row
    // that SURVIVED this archive — surfaced with the SAME 'live-descriptor' reason
    // the safety gate gives every other kept row, so the caller's report still
    // accounts for every row it did not retire.
    // The survivor, when it is not the archived id, is by construction descriptor-
    // backed AND live-session (pickArchiveForwardSurvivor's strict filter), so
    // 'live-descriptor' is a FACT here, not a hopeful label.
    const rowOf = new Map(candidates.map((d) => [String(d.id), d]));
    if (survivorId !== String(archivedId)) out.left.push({ id: survivorId, reason: 'live-descriptor' });
    for (const x of r.left) {
      // Distinguish the ways a row survives the fold, so the reason is a FACT rather
      // than a guess: a descriptor-backed row with a LIVE session (a distinct live
      // child — the safety gate), a descriptor-backed row whose session is DEAD (a
      // crashed sibling whose stale descriptor kept the conservative gate from
      // retiring it — it is NOT draining anything), or a row whose atomic conditional
      // tombstone was refused because it changed under us (a re-register raced the
      // fold). See archiveLeftReason. Key off the row the pass ITSELF acted on
      // (r.leftRows — the in-lock re-read foldOne classified), not the pre-lock
      // `rowOf` snapshot: a row whose liveness changed inside the lock window
      // must not get a reason derived from stale pre-lock state. Fail open to
      // the pre-lock snapshot only if leftRows has nothing for this id.
      out.left.push({ id: String(x), reason: archiveLeftReason(home, x, (r.leftRows && r.leftRows.get(String(x))) || rowOf.get(String(x))) });
    }
    for (const x of r.forwardFailed) out.left.push({ id: String(x), reason: 'forward-failed' });
    // Candidates we deliberately skipped (their own lock was held, or the in-lock
    // re-read failed): NOT retired, NOT forwarded, surfaced with the real reason.
    for (const x of r.skipped) out.left.push({ id: String(x.id), reason: x.reason });
    return out;
  } catch (_) { return out; } // fail-open: a group retire must never break archive itself
}

// canonicalWorktreeRealPath(worktreePath) — the collision-FREE real-path pre-image
// of canonicalMeshId's 8-hex hash: canonicalize to the GIT TOPLEVEL first
// (resolveCallerWorktree — IDENTICAL resolution to canonicalMeshId below), then take
// its resolved real path (inst.worktreeRealPath). By construction
// canonicalMeshId(wt) === `primary-<first 8 hex of sha256(canonicalWorktreeRealPath(wt))>`,
// so two rows share a canonicalMeshId BUCKET iff this real path hashes to the same
// 8-hex — but they are the SAME physical worktree ONLY iff these real-path STRINGS
// are EQUAL. An 8-hex sha256 slice can (astronomically, but on a money path "can" is
// disqualifying) collide two DISTINCT toplevels onto ONE meshId, so grouping by the
// hash alone can bucket two UNRELATED worktrees together; comparing this real-path
// string-for-string is the collision-proof discriminator. This is the ONE helper
// BOTH retireWorktreeDuplicates (per-register) and foldMeshDuplicates (project-wide
// migration) match candidates with, so the fold can never again silently merge
// distinct worktrees the way a hash-only grouping did. Fail-open null (falsy path)
// -> callers treat it as "cannot confirm same worktree" (never merge).
function canonicalWorktreeRealPath(worktreePath) {
  if (!worktreePath) return null;
  const top = resolveCallerWorktree(worktreePath) || worktreePath;
  return inst.worktreeRealPath(top) || null;
}

// canonicalMeshId(worktreePath) — the meshId a row groups under. Canonicalizes to
// the row's GIT TOPLEVEL first (resolveCallerWorktree — git rev-parse
// --show-toplevel, pure-fs findGitToplevel fallback), so a legacy SUBDIR-SPLIT row
// (a child that registered from a git subdirectory — its raw real-path hashes to a
// DIFFERENT meshId than the toplevel's, invisible to plain-hash grouping) folds
// onto its toplevel. Falls back to the raw worktreePath when it does not resolve
// (a vanished path — already surfaced by staleRegistryPartitions — or a non-git
// dir), which reproduces the pre-existing plain-hash grouping exactly for every
// row that is already a toplevel. Submodules resolve to their OWN toplevel -> a
// submodule is correctly NOT merged with its parent.
function canonicalMeshId(worktreePath) {
  const top = resolveCallerWorktree(worktreePath) || worktreePath;
  return inst.primaryWorkspaceId(top);
}

// groupRegistryByMeshId(registry) -> Map<meshId, {meshId, ids[], rows[], liveRows}>.
// The ONE grouping implementation shared by cmdDiagnose (split detection) AND
// foldMeshDuplicates (canonical fold) — grouping key is canonicalMeshId so both
// see subdir-splits folded onto their toplevel identically.
function groupRegistryByMeshId(registry) {
  const byMesh = new Map();
  for (const d of registry) {
    if (!d || !d.worktreePath) continue;
    const meshId = canonicalMeshId(d.worktreePath);
    if (!meshId) continue;
    let g = byMesh.get(meshId);
    if (!g) { g = { meshId, ids: [], rows: [], liveRows: 0 }; byMesh.set(meshId, g); }
    g.ids.push(d.id);
    g.rows.push(d);
    if (isLiveSessionId(d.sessionId)) g.liveRows++;
  }
  return byMesh;
}

// pickSurvivor(s, group) — the SAME freshest-live selection resolveMeshTarget uses
// (greatest registry updatedAt among LIVE rows; cursor-value tiebreak; else the
// first row — the phantom, pre-self-register), generalized to a canonical group's
// OWN rows (which include subdir-split rows resolveMeshTarget's plain-hash match
// would miss). The survivor is the partition a live session actually drains.
function pickSurvivor(s, group) {
  let firstMatch = null;
  let bestLive = null;
  for (const d of group.rows) {
    if (!d) continue;
    if (firstMatch === null) firstMatch = d;
    if (!isLiveSessionId(d.sessionId)) continue; // not live (A6: excludes the synthetic auto-ensure marker too)
    if (bestLive === null) { bestLive = d; continue; }
    const a = Number.isFinite(d.updatedAt) ? d.updatedAt : -1;
    const b = Number.isFinite(bestLive.updatedAt) ? bestLive.updatedAt : -1;
    if (a > b) { bestLive = d; continue; }
    if (a === b && meshCursorValue(s, d.id) > meshCursorValue(s, bestLive.id)) bestLive = d;
  }
  return bestLive || firstMatch;
}

// rekeySubdirRegistryRows(s, dryRun) — P1b: reconcile the two identity views so a
// subdir-registered row is addressable by its TOPLEVEL meshId. resolveMeshTarget
// (send) matches a row by inst.primaryWorkspaceId(d.worktreePath) — the RAW stored
// path — while the fold groups by canonicalMeshId (git TOPLEVEL). An OLD store's row
// registered from a git SUBDIR stored a raw-subdir path whose meshId != its toplevel
// meshId, so `send --to <toplevel meshId>` failed closed as unregistered-recipient,
// and a LONE such row is skipped by the >=2 fold. Re-key it IN PLACE: rewrite the
// stored worktreePath to its canonical git toplevel, so the raw-path meshId
// resolveMeshTarget hashes BECOMES the toplevel meshId. This is a registry UPDATE
// (same id) — the partition (d.id, where the row's messages live) is UNCHANGED, so NO
// message move is needed; and it makes send + fold agree on ONE identity. A submodule
// resolves to its OWN toplevel and keeps a DISTINCT meshId (never merged into the
// parent). Non-git / unresolvable paths are left as-is (raw path IS their own meshId).
// Returns the count of re-keyed ids. dryRun classifies without writing (doctor detect).
//
// P1c (v0.62.0 lock hardening): the APPLY path is a per-id read-modify-write —
// it carries d.sessionId/inboxPath/cursorPath/nudgeCommand forward so the rekey
// only rewrites worktreePath. That snapshot is read from listRegistry() OUTSIDE
// any lock, so a concurrent register/ensure/heartbeat/re-home for the SAME id
// (each of which runs under withIdLock and can update those very fields) could
// land BETWEEN this snapshot and the upsert — and the upsert would then clobber
// the concurrent update back to the STALE snapshot values (a classic lost
// update: e.g. a child that just registered its real durable inboxPath gets it
// nulled out). foldMeshDuplicates is invoked from doctor's repair (apply) with
// NO id lock held, so this race is genuinely reachable against a live child.
// Fix: run each row's write under withIdLock(id) AND re-derive from a FRESH
// in-lock re-read of the row (the lock only serializes the write window; writing
// the pre-lock snapshot would still lose the update). A lock-busy row (another
// op mid-mutation) is SKIPPED and surfaced, never written unlocked — the rekey
// is idempotent, so the next doctor run re-detects and re-keys it. dryRun takes
// no lock (pure classification, no write). NB no deadlock: foldMeshDuplicates
// holds no per-id lock when it calls this, so the per-id acquire here is never
// re-entrant.
function rekeySubdirRegistryRows(s, home, dryRun) {
  let rekeyed = 0;
  // needsRekey(row) -> canonical toplevel path to write, or null if the row is
  // already canonical / non-git / unresolvable. The SAME classification is used
  // for the outer snapshot pass and the in-lock re-read so both agree.
  const needsRekey = (row) => {
    if (!row || !row.worktreePath || row.id == null) return null;
    const top = resolveCallerWorktree(row.worktreePath);
    if (!top) return null; // non-git / unresolvable -> raw path is already its own meshId
    const canonMesh = inst.primaryWorkspaceId(top);
    if (!canonMesh || inst.primaryWorkspaceId(row.worktreePath) === canonMesh) return null; // already canonical
    return top;
  };
  for (const d of s.listRegistry()) {
    if (!needsRekey(d)) continue;
    if (dryRun) { rekeyed++; continue; }
    const r = withIdLock(d.id, home, () => {
      // Re-read the CURRENT row under the lock — a concurrent mutator may have
      // changed worktreePath/sessionId/inboxPath/... (or removed the row) since
      // the snapshot above. Never write stale snapshot fields.
      const cur = s.listRegistry().find((x) => x && String(x.id) === String(d.id));
      const curTop = needsRekey(cur);
      if (!curTop) return { rekeyed: false }; // row vanished, or already canonical now
      s.upsertRegistry({
        id: cur.id,
        worktreePath: curTop, // rewritten to the canonical git toplevel (send+fold now agree)
        sessionId: cur.sessionId,
        inboxPath: cur.inboxPath,
        cursorPath: cur.cursorPath,
        nudgeCommand: cur.nudgeCommand,
      }, { allowPathChange: true }); // F2 guard bypass: intentional same-id subdir->toplevel rewrite, not a hash collision
      return { rekeyed: true };
    });
    if (r && r.lockBusy) {
      // Surfaced, NOT silently dropped: idempotent, so the next fold/doctor run re-keys it.
      try {
        process.stderr.write('[devswarm] rekeySubdirRegistryRows: id ' + JSON.stringify(d.id)
          + ' is locked by another operation in progress — skipped this pass (re-keyed on the next run)\n');
      } catch (_) {}
      continue;
    }
    if (r && r.rekeyed) rekeyed++;
  }
  return rekeyed;
}

// foldMeshDuplicates(home, ctx) — MIGRATION generalization of
// retireWorktreeDuplicates over the WHOLE registry (not one live caller's
// worktree). Groups every registry row by canonical (git-toplevel) mesh identity
// and, for each group with 2+ rows, forwards every non-survivor's real direct
// backlog into the survivor and tombstones the store-only duplicates (leaving
// descriptor-backed ones), via the SHARED foldGroupIntoSurvivor primitive. This
// folds the prior mesh forms an OLD store accumulated — phantom rows, dual/legacy
// pairs, SUBDIR-SPLIT pairs — that the drain-only `reconcile` never dedups.
//   - Idempotent (hash-dedup forward + tombstone-of-absent -> a re-run finds no
//     store-only duplicate left, so retired:[]), fail-open (never throws),
//     non-destructive (forward-before-tombstone; message rows are NEVER deleted).
//   - Orphan partitions / stale-registry rows are DELIBERATELY untouched — they are
//     surface-only by explicit design (computeSummary's no-delete posture); this
//     only collapses same-worktree DUPLICATE registrations.
//   - `ctx.dryRun` classifies without writing (doctor detect()).
// Returns { ok, retired[], forwarded, folded, [left[]], [forwardFailed[]] }.
function foldMeshDuplicates(home, ctx) {
  const c = ctx || {};
  const dryRun = !!c.dryRun;
  try {
    const repoKey = repoKeyForCwd(c);
    // NEVER open/create the shared store just to look for duplicates. A missing
    // repoKey (non-git cwd) or an absent per-project store dir means there is no
    // registry to fold — return a clean no-op WITHOUT calling openStore (which
    // would create the dir; doctor's repair/--check store-untouched invariant).
    if (!repoKey) return { ok: true, retired: [], forwarded: 0, folded: 0 };
    let storeExists = false;
    try { storeExists = fs.existsSync(store.storeDirForHash(home, repoKey)); } catch (_) { storeExists = false; }
    if (!storeExists) return { ok: true, retired: [], forwarded: 0, folded: 0 };
    const s = store.openStore({ home, hash: repoKey, backend: c.backend, env: c.env });
    const retired = [];
    const left = [];
    const forwardFailed = [];
    let forwarded = 0;
    let folded = 0; // canonical groups that had ≥1 duplicate acted on
    let meshIdCollisions = 0; // meshId buckets spanning ≥2 DISTINCT canonical worktrees
    let rekeyed = 0; // P1b: subdir rows re-keyed to their canonical toplevel worktreePath
    try {
      // P1b FIRST: re-key any subdir-registered row to its toplevel worktreePath so
      // resolveMeshTarget (send) and the fold agree on ONE identity — including a LONE
      // subdir row the >=2 fold below never touches. Re-key is an in-place registry
      // update (same id/partition), so the fresh listRegistry the fold reads next just
      // sees canonical paths (grouping is by canonicalMeshId either way — unaffected).
      rekeyed = rekeySubdirRegistryRows(s, home, dryRun);
      const byMesh = groupRegistryByMeshId(s.listRegistry());
      for (const g of byMesh.values()) {
        if (g.rows.length < 2) continue; // fast skip: a lone row cannot have a duplicate
        // COLLISION GUARD (P0): a canonicalMeshId bucket is keyed by an 8-hex sha256
        // slice, which can (astronomically) collide two DISTINCT worktrees onto ONE
        // meshId. Fold ONLY within a real-path-identical sub-group — NEVER
        // merge/forward/tombstone across two distinct worktrees that merely share the
        // 8-hex. Sub-partition by the collision-free canonicalWorktreeRealPath (the
        // SAME comparison retireWorktreeDuplicates uses); an unresolvable path gets its
        // OWN singleton key so it is never merged with anything.
        const bySamePath = new Map(); // canonicalRealPath -> rows[]
        for (const d of g.rows) {
          const real = canonicalWorktreeRealPath(d.worktreePath);
          const key = real || ('\x00unresolved:' + String(d.id));
          let sub = bySamePath.get(key);
          if (!sub) { sub = []; bySamePath.set(key, sub); }
          sub.push(d);
        }
        if (bySamePath.size > 1) {
          meshIdCollisions++;
          try {
            process.stderr.write('[devswarm] foldMeshDuplicates: meshId ' + String(g.meshId)
              + ' bucket spans ' + bySamePath.size + ' DISTINCT canonical worktrees (8-hex hash collision)'
              + ' — folding each in isolation, NEVER across\n');
          } catch (_) {}
        }
        for (const rows of bySamePath.values()) {
          if (rows.length < 2) continue; // no duplicate within this real worktree
          const survivor = pickSurvivor(s, { rows });
          if (!survivor || survivor.id == null) continue; // nothing live/first to keep -> skip
          const candidates = rows.filter((d) => d && String(d.id) !== String(survivor.id));
          const r = foldGroupIntoSurvivor(s, home, survivor.id, candidates, { dryRun });
          forwarded += r.forwarded;
          for (const x of r.retired) retired.push(x);
          for (const x of r.left) left.push(x);
          for (const x of r.forwardFailed) forwardFailed.push(x);
          if (r.retired.length || r.left.length || r.forwardFailed.length) folded++;
        }
      }
      // Same forwarded-without-retired gap as retireWorktreeDuplicates above: a fold
      // whose candidates are all descriptor-backed still FORWARDS unread rows, which
      // must be reflected in the projection. (dryRun forwards nothing, so it stays out.)
      if (!dryRun && (retired.length || forwarded)) store.deriveSummary(s, { home, env: c.env });
    } finally { s.close(); }
    const out = { ok: true, retired, forwarded, folded };
    if (left.length) out.left = left;
    if (forwardFailed.length) out.forwardFailed = forwardFailed;
    if (meshIdCollisions) out.meshIdCollisions = meshIdCollisions;
    if (rekeyed) out.rekeyed = rekeyed;
    return out;
  } catch (e) {
    // A5(b): fail-open means "never THROW into update/doctor" — it does NOT
    // mean "report success for a run that raised". A caught exception here
    // previously reported ok:true with an empty retired/forwarded/folded set,
    // indistinguishable from "nothing needed folding". Report the failure;
    // control flow is unchanged (still returns normally, never throws).
    return { ok: false, error: String(e && e.message || e), retired: [], forwarded: 0, folded: 0 };
  }
}

// foldArchivedRegistryRows(home, ctx0) — FORWARD MIGRATION for registries that
// were ALREADY split by the archive bug before the fix shipped (this repo's
// persisted-shape rule: a shape change ships a migration in BOTH update and
// doctor). cmdArchive used to tombstone exactly ONE id per archive, so every
// registry that saw an archive under the old code can still hold live rows for
// worktrees whose workspace is archived — and a live row is what makes
// computeSummary/roster project that workspace as ACTIVE. This sweep applies the
// SAME forward-then-tombstone + safety gate cmdArchive now applies at archive
// time (retireArchivedWorktreeGroup), retroactively.
//
// SCOPE — every id form and every bucket form, without enumerating either:
//   - ID FORMS: rows are matched by the archived descriptor's canonical worktree
//     REAL PATH (canonicalWorktreeRealPath), which is form-AGNOSTIC — a
//     `primary-<8hex>` canonical row, a `primary-<8hex>` derived from a SUBDIR
//     pre-image (canonicalWorktreeRealPath resolves to the git TOPLEVEL first, so
//     a subdir row matches its toplevel), a hivecontrol builder UUID, and a legacy
//     `<label>-<repoId8>` row all match on the SAME real path. The archived id's
//     OWN row is additionally matched by id, so a row whose worktreePath is
//     missing/unresolvable is still retired.
//   - BUCKET FORMS: store.listStoreHashes enumerates EVERY per-project store
//     directory, which covers both `store/<repoKey>` (`<sanitized-name>-<6hex>`)
//     and the LEGACY `store/<8hex>` hashFromWorkspaceId bucket without special-
//     casing either.
//
// PROPERTIES (all four are load-bearing):
//   - IDEMPOTENT: a retired row is gone from listRegistry, so a second run finds
//     no rows for any archived id and reports nothing to do.
//   - FAIL-OPEN, HONESTLY: never throws into update/doctor — but a run that RAISED
//     reports ok:false with the error, never a clean no-op (the same posture as
//     foldMeshDuplicates' catch). Per-store and per-id errors are counted, and one
//     store's failure never aborts the sweep.
//   - NO-DELETE: message rows are NEVER deleted. Unread directs are FORWARDED into
//     the archived id's partition first; only REGISTRY rows are tombstoned.
//   - SAFETY-GATED: foldGroupIntoSurvivor leaves any row with its own LIVE
//     descriptor, so a distinct live workspace that merely shares a worktree is
//     never silently archived — it is reported in `left` with a reason.
// `ctx0.dryRun` classifies without writing (doctor detect()); it takes no lock
// and performs no forward/tombstone. The APPLY path runs each archived id's work
// under withIdLock(id) — an unlocked read-modify-write here is a lost-update bug
// against a concurrent unarchive/register for the same id (the same reasoning as
// rekeySubdirRegistryRows). A lock-busy id is SURFACED and retried next run.
function foldArchivedRegistryRows(home, ctx0) {
  const ctx = Object.assign({ home, env: process.env }, ctx0 || {});
  const dryRun = !!(ctx0 && ctx0.dryRun);
  const out = {
    ok: true, action: 'fold-archived-rows', dryRun,
    scanned: 0, pending: 0, retired: [], forwarded: 0, left: [], errors: 0,
  };
  try {
    // 1) Every GENUINELY archived workspace: archived/<id>.json present AND
    //    workspaces/<id>.json absent (the same test isArchivedOnlyWorkspace uses —
    //    a mid-archive/crashed state has BOTH and is applyRecoveryIntents' job,
    //    not this migration's).
    const ad = checkedArchivedDir(home);
    if (!ad.ok || !ad.exists) return out;
    let names = [];
    try { names = fs.readdirSync(ad.path); } catch (_) { names = []; }
    const archived = [];
    for (const n of names) {
      if (!/\.json$/.test(n)) continue;
      const id = n.slice(0, -'.json'.length);
      if (!isSafeId(id)) continue;
      if (fs.existsSync(descriptorPath(home, id))) continue; // still live -> not archived
      const st = readDescriptorPathState(path.join(ad.path, n));
      const d = st.descriptor;
      if (!d || String(d.id) !== id) continue;
      archived.push({ id, real: d.worktreePath ? canonicalWorktreeRealPath(d.worktreePath) : null });
      out.scanned++;
    }
    if (!archived.length) return out;

    // 2) Sweep EVERY per-project store bucket (both bucket forms — see header).
    let hashes = [];
    try { hashes = store.listStoreHashes(home) || []; } catch (_) { hashes = []; }
    for (const bucket of hashes) {
      let s = null;
      try { s = store.openStore({ home, hash: bucket, backend: ctx.backend, env: ctx.env }); }
      catch (_) { out.errors++; continue; } // unreadable store: SKIPPED, never wiped
      try {
        for (const a of archived) {
          let rows = [];
          try { rows = s.listRegistry() || []; } catch (_) { out.errors++; continue; }
          const ownRow = rows.find((d) => d && d.id != null && String(d.id) === a.id) || null;
          const sameWorktree = a.real
            ? rows.filter((d) => d && d.id != null && String(d.id) !== a.id && d.worktreePath
                && canonicalWorktreeRealPath(d.worktreePath) === a.real)
            : [];
          if (!ownRow && !sameWorktree.length) continue; // nothing of this archived id lives here
          // WHERE the siblings' unread goes — chosen by LIVENESS, identical rule to
          // the archive-time path (pickArchiveForwardSurvivor; see its header). The
          // archived id's own row is tombstoned a few lines below, so forwarding into
          // it while a LIVE sibling still holds this worktree would bury a real
          // unanswered direct in a partition nothing drains.
          const survivorId = pickArchiveForwardSurvivor(s, home, a.id, sameWorktree);
          const foldCandidates = sameWorktree.filter((d) => d && String(d.id) !== survivorId);
          const survivorIsOther = survivorId !== String(a.id);
          // Snapshot rows by id so a LEFT row's reported reason can name the real
          // reason (live vs descriptor-backed-but-session-dead) — see archiveLeftReason.
          const rowOf = new Map(sameWorktree.map((d) => [String(d.id), d]));
          if (dryRun) {
            // Pure classification, no lock and no write: foldGroupIntoSurvivor's own
            // dryRun mode decides which siblings WOULD retire (identical rule to the
            // apply path — one classifier, never a second reimplementation).
            const c = foldGroupIntoSurvivor(s, home, survivorId, foldCandidates, { dryRun: true });
            for (const x of c.retired) { out.retired.push(String(x) + '@' + bucket); out.pending++; }
            if (survivorIsOther) out.left.push({ id: survivorId, bucket, reason: 'live-descriptor' });
            for (const x of c.left) out.left.push({ id: String(x), bucket, reason: archiveLeftReason(home, x, rowOf.get(String(x))) });
            if (ownRow) { out.retired.push(a.id + '@' + bucket); out.pending++; }
            continue;
          }
          const r = withIdLock(a.id, home, () => {
            // Forward-before-tombstone for the siblings, THEN retire the archived
            // id's own surviving row. Order matters: the siblings' unread must land
            // in this partition while it is still the survivor.
            // lockCandidates: the siblings are locked individually so a sibling
            // that is mid-cmdRegister is never tombstoned out from under itself
            // (see retireArchivedWorktreeGroup's LOCKING note). a.id's own lock is
            // held by THIS withIdLock and is never re-acquired — every sibling id
            // is != a.id by the filter above, and the survivor is excluded from the
            // candidates entirely (never locked, never forwarded from, never
            // tombstoned), so a live survivor cannot self-deadlock this pass either.
            const g = foldGroupIntoSurvivor(s, home, survivorId, foldCandidates, { lockCandidates: true });
            let ownRetired = false;
            if (ownRow) {
              // ATOMIC conditional tombstone on the exact snapshot: a workspace
              // un-archived/re-registered between the scan and here must NOT be
              // silently re-tombstoned (its descriptor would then be live again —
              // caught next run, when it no longer classifies as archived).
              try {
                ownRetired = !!s.removeRegistryIf(ownRow.id, {
                  sessionId: ownRow.sessionId, updatedAt: ownRow.updatedAt, writeSeq: ownRow.writeSeq,
                });
              } catch (_) { ownRetired = false; }
            }
            return { g, ownRetired };
          });
          if (r && r.lockBusy) {
            // Surfaced, never silently dropped — idempotent, so the next run retries.
            out.left.push({ id: a.id, bucket, reason: 'lock-busy' });
            continue;
          }
          const g = r.g;
          out.forwarded += g.forwarded;
          for (const x of g.retired) out.retired.push(String(x) + '@' + bucket);
          // The live survivor is not retired — surfaced with the same reason every
          // other kept same-worktree row gets, so the report stays complete.
          if (survivorIsOther) out.left.push({ id: survivorId, bucket, reason: 'live-descriptor' });
          for (const x of g.left) {
            // Key off g.leftRows (the in-lock re-read the pass actually classified),
            // not the pre-lock rowOf snapshot — same reasoning as
            // retireArchivedWorktreeGroup. Fail open to rowOf if leftRows has nothing.
            out.left.push({ id: String(x), bucket, reason: archiveLeftReason(home, x, (g.leftRows && g.leftRows.get(String(x))) || rowOf.get(String(x))) });
          }
          for (const x of g.forwardFailed) out.left.push({ id: String(x), bucket, reason: 'forward-failed' });
          for (const x of g.skipped) out.left.push({ id: String(x.id), bucket, reason: x.reason });
          if (r.ownRetired) out.retired.push(a.id + '@' + bucket);
          else if (ownRow) out.left.push({ id: a.id, bucket, reason: 'raced-re-register' });
          // Refresh the projection whenever anything actually changed — a forward
          // with no tombstone still delivers real messages that must be visible to
          // every summary.json reader (the same gap retireWorktreeDuplicates closes).
          if (g.retired.length || g.forwarded || r.ownRetired) {
            try { store.deriveSummary(s, { home, env: ctx.env }); } catch (_) { out.errors++; }
          }
        }
      } finally { try { s.close(); } catch (_) {} }
    }
    if (!dryRun) out.pending = out.retired.length;
    out.ok = out.errors === 0;
    return out;
  } catch (e) {
    // Fail-open means "never THROW into update/doctor" — NOT "report success for a
    // run that raised" (foldMeshDuplicates' precedent).
    return { ok: false, action: 'fold-archived-rows', dryRun, error: String(e && e.message || e),
      scanned: out.scanned, pending: 0, retired: out.retired, forwarded: out.forwarded, left: out.left, errors: out.errors + 1 };
  }
}

// ============================================================================
// Phase 7 (PLAN-v0.57-mesh.md) — send-time self-heal. Invoked BEFORE every
// send-like verb (mesh `send`, `inbox pull`'s native drain, `archive-request`'s
// `message-child`): checks THIS project's per-project daemon health
// (ingestHealth.daemonHealth, D25 — running+healthy, not freshness-only) and,
// when it looks stale/missing, best-effort spawns the (idempotent) repoKey
// installer to self-heal it — NEVER blocking the caller's own action, which
// always proceeds regardless of readiness (the native queue buffers; a
// send-direct mesh write is daemon-independent by design, D8).
// ============================================================================
const SELF_HEAL_COOLDOWN_MS = 60 * 1000; // O-D7

function selfHealCooldownPath(home, repoKey) {
  return path.join(devswarmRoot(home), 'self-heal', 'ingest-' + repoKey + '.json');
}
function selfHealCooldownElapsed(home, repoKey, now, F) {
  try {
    const st = JSON.parse((F || fs).readFileSync(selfHealCooldownPath(home, repoKey), 'utf8'));
    const last = st && Number.isFinite(st.lastAttemptAt) ? st.lastAttemptAt : null;
    if (last === null) return true;
    return (now - last) >= SELF_HEAL_COOLDOWN_MS;
  } catch (_) {
    return true; // no/unreadable state -> treat as elapsed (heal now)
  }
}
// markSelfHealAttempt — record this attempt's timestamp (atomic tmp+rename),
// same idiom as hooks/devswarm-parent-inbox.js's markArchiveNudged. Best-effort:
// a failed write only means a future call may re-attempt sooner than the
// cooldown intends — never blocks the caller.
function markSelfHealAttempt(home, repoKey, now, F) {
  try {
    const G = F || fs;
    const p = selfHealCooldownPath(home, repoKey);
    G.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    G.writeFileSync(tmp, JSON.stringify({ lastAttemptAt: now }));
    G.renameSync(tmp, p);
  } catch (_) {}
}

// defaultSpawnInstaller(worktree, home, env) — run the plugin's OWN idempotent
// installer as a subprocess, cwd'd INSIDE the target worktree (so its own
// resolveMainWorktree/repoKey derivation lands on the SAME project) with HOME
// threaded — the same spawn shape as hooks/lib/doctor-repair.js's
// spawnInstaller / skills/update/scripts/update.js's healIngestDaemon.
function defaultSpawnInstaller(worktree, home, env) {
  const installerPath = path.join(__dirname, '..', 'companion', 'install-devswarm-ingest.js');
  try {
    return spawnSync(process.execPath, [installerPath], {
      cwd: worktree, env: Object.assign({}, env, { HOME: home }), encoding: 'utf8', timeout: 30000,
    });
  } catch (_) {
    return null;
  }
}

// selfHeal(ctx) -> { daemonHealthy?:true, daemonWarning?:string, daemonHealAttempted?:true }
// NEVER throws (fail-open — a self-heal failure must never block the caller's
// own action) and never blocks: the caller always proceeds with its own verb
// regardless of what this returns.
//   'unsupported-platform' — win32 (D28): no daemon possible there, no spawn.
//   'no-worktree'          — cwd is not inside a resolvable git worktree; the
//                             self-heal GATE (isDevswarmActive && a resolved
//                             worktree) can never open, so no spawn either.
//   'stale'                — daemon looks stale/missing. Spawns the installer
//                             ONLY when gated (isDevswarmActive(env) AND the
//                             worktree resolved, already true by this point)
//                             AND the cooldown has elapsed; `daemonHealAttempted`
//                             is set true iff a spawn actually happened.
function selfHeal(ctx) {
  try {
    const platform = (ctx.io && ctx.io.platform) || process.platform;
    if (platform === 'win32') return { daemonWarning: 'unsupported-platform' };

    const env = ctx.env || process.env;
    const cwd = ctx.cwd || process.cwd();
    const home = ctx.home || os.homedir();
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();

    const resolveWt = (ctx.io && ctx.io.resolveWorktree)
      || (() => inst.resolveWorktree(cwd) || findGitToplevel(cwd));
    const worktree = resolveWt(cwd);
    if (!worktree) return { daemonWarning: 'no-worktree' };

    const resolveKey = (ctx.io && ctx.io.repoKeyForWorktree) || repokey.repoKeyForWorktree;
    let repoKey = null;
    try { repoKey = resolveKey(worktree); } catch (_) { repoKey = null; }

    const health = ingestHealth.daemonHealth(home, repoKey, { now, platform, io: ctx.io && ctx.io.health });
    if (health.status === 'unsupported') return { daemonWarning: 'unsupported-platform' };
    if (health.status === 'healthy') return { daemonHealthy: true };

    // stale/missing. The SPAWN (never the health read above) is gated.
    if (!isDevswarmActive(env) || !repoKey) return { daemonWarning: 'stale' };

    const F = (ctx.io && ctx.io.fs) || fs;
    if (!selfHealCooldownElapsed(home, repoKey, now, F)) {
      return { daemonWarning: 'stale', daemonHealCooldown: true };
    }
    markSelfHealAttempt(home, repoKey, now, F);
    const spawn = (ctx.io && ctx.io.spawnInstaller) || defaultSpawnInstaller;
    const spawnResult = spawn(worktree, home, env);
    // A5(a): the installer spawn's own outcome used to be discarded entirely —
    // an installer failing on EVERY attempt was silently retried forever with
    // nothing surfaced. Capture + report it. `defaultSpawnInstaller` returns
    // either `null` (the spawn itself threw — caught there) or a real
    // spawnSync result (`.error` set on a genuine spawn failure, `.status`
    // non-zero on the installer's own non-zero exit). A test/injected
    // `spawnInstaller` double that returns `undefined` (no signal either way —
    // the common "just count the call" convention used throughout this
    // codebase's own test suite) is NOT treated as a failure: only a
    // POSITIVE signal (an explicit null, an `.error`, or a non-zero
    // `.status`) counts, per the fail-open-on-ambiguity posture.
    const spawnFailed = spawnResult === null
      || !!(spawnResult && (spawnResult.error
        || (Number.isFinite(spawnResult.status) && spawnResult.status !== 0)));
    if (spawnFailed) {
      try {
        const detail = (spawnResult && spawnResult.error)
          ? String((spawnResult.error && spawnResult.error.message) || spawnResult.error)
          : (spawnResult === null ? 'installer spawn threw' : ('installer exited with status ' + spawnResult.status));
        alog.logError('devswarm-cli', 'self-heal-installer', detail, { repoKey });
      } catch (_) { /* logging must never break self-heal */ }
      return { daemonWarning: 'stale', daemonHealAttempted: true, daemonHealFailed: true };
    }
    return { daemonWarning: 'stale', daemonHealAttempted: true };
  } catch (_) {
    return {}; // fail-open: self-heal must never throw or block the caller
  }
}

// withSelfHeal(fn, ctx) — runs selfHeal(ctx) BEFORE `fn()` (the send-like
// action), then merges the heal outcome's fields onto `fn()`'s result object
// (never overwriting the action's own `ok`/`error`/etc. keys). `fn()`'s own
// result always wins the response; self-heal only ADDS informational fields.
function withSelfHeal(fn, ctx) {
  const heal = selfHeal(ctx);
  const r = fn();
  if (heal && r && typeof r === 'object') {
    if (heal.daemonWarning) r.daemonWarning = heal.daemonWarning;
    if (heal.daemonHealthy) r.daemonHealthy = true;
    if (heal.daemonHealAttempted) r.daemonHealAttempted = true;
    if (heal.daemonHealCooldown) r.daemonHealCooldown = true;
  }
  return r;
}

// precreateCursorAndInbox(desc) — idempotent, non-destructive precreate of a
// descriptor's CURRENT cursorPath/inboxPath. Shared by cmdRegister's create
// path AND its ensure/exists path (a descriptor whose inbox/cursor was
// repointed to a new path — e.g. a worktree-local `.devswarm-temp/inbox.ndjson`
// override — must get this precreate too: without it the cursor never gets
// created, `inbox count/read` returns known:false forever, and
// devswarm-parent-gate.js's Stop-hook gate reads that as "inbox unreadable"
// for what is actually a live, active workspace. Path-agnostic: works for the
// central-store default path (devswarmRoot/inbox|cursors/<id>) exactly the
// same as any custom repointed path — never special-cased.
//
// Initialize the durable cursor to 0 (nothing consumed yet) IF it does not
// already exist — so `inbox count/read` immediately reports all messages as
// unread. Without a cursor file, unreadBacklog returns known:false (a
// fail-safe for the liveness path) which would read as "nothing pending".
// NON-DESTRUCTIVE: never clobbers an existing cursor.
//
// Initialize an EMPTY durable inbox file IF it does not already exist — so a
// freshly-registered child reads as known:true/0-unread (confirmed-empty)
// rather than known:false (unreadable/absent, devswarm-parent-gate.js's
// Stop-hook gate's genuine-anomaly signal). Without this, "just registered,
// never messaged" and "genuinely neglected, inbox never written" are the
// SAME fs state (cursor present, inbox absent) and the gate cannot tell them
// apart. TRUNCATION-PROOF CREATE (P0 data-loss fix, hardened): a plain
// `existsSync` + `writeFileSync` (default flag 'w', which TRUNCATES) is a
// TOCTOU race — a concurrent devswarm-pull.js drain (companion/lib/devswarm-
// pull.js) can create + durably append to this SAME inboxPath, under its OWN
// per-id lock that register never takes, in the window between the
// existsSync check and the write, and the truncating write then ERASES that
// real content. An earlier fix used `wx` (exclusive create, fails closed on
// EEXIST), but O_EXCL exclusivity is documented as unreliable over some
// network filesystems (NFS). `a` (append) sidesteps this entirely: it opens
// for append and CREATES the file if absent, and appending '' never
// truncates existing content on ANY filesystem — no reliance on O_EXCL
// exclusivity at all. So this can NEVER clobber a pull-written inbox, race
// or no race, on any filesystem. Cross-platform (supported on win32/macOS/
// linux). Fail-open: any error (permissions etc.) is swallowed — best-effort
// init only; append mode does not throw on an already-existing file.
function precreateCursorAndInbox(desc) {
  if (desc.cursorPath) {
    try {
      fs.mkdirSync(path.dirname(desc.cursorPath), { recursive: true });
      fs.writeFileSync(desc.cursorPath, '0', { flag: 'wx' });
    } catch (_) { /* fail-open: best-effort init only, non-fatal (matches inbox block below) */ }
  }
  if (desc.inboxPath) {
    try {
      fs.mkdirSync(path.dirname(desc.inboxPath), { recursive: true });
      fs.writeFileSync(desc.inboxPath, '', { flag: 'a' });
    } catch (_) { /* fail-open: best-effort init only, non-fatal to registration */ }
  }
}

// ----- subcommands -----
// cmdRegister — the WHOLE descriptor+registry mutation runs under the per-id
// lock (P1-4): register / ensure serialize against a concurrent archive/reap for
// the same id, so archive can never delete a descriptor register replaced after
// archive's inode check, and ensure never interleaves with a re-home.
function cmdRegister(id, flags, ctx, { requireNew } = {}) {
  const home = ctx.home;
  return withIdLock(id, home, () => {
  let existing = readDescriptorFile(home, id);
  if (requireNew && existing) {
    // ensure: idempotent — preserve the descriptor fields, backfilling only a
    // structurally-proven legacy ownerKey, then re-upsert the store registry. Also reconcile
    // any legacy/phantom duplicate row for this SAME worktree every time (the
    // steady-state child path: `inbox pull` auto-ensures each turn), so a
    // duplicate created AFTER the child's first register is still retired.
    //
    // FIX (split-brain gate nag): this branch used to skip the cursor/inbox
    // precreate entirely (only the CREATE path below ran it). A descriptor
    // repointed to a path whose cursor was never created then stayed
    // known:false forever, even though `inbox pull` re-enters THIS branch
    // every turn — the ensure path must precreate too, using the descriptor's
    // CURRENT (possibly repointed) paths, not whatever this call's flags say.
    const currentRepoKey = repoKeyForCwd(ctx);
    // P1-1/P1-2 RE-HOME: if the descriptor is stranded in the legacy hash bucket
    // (persisted ownerKey === hashFromWorkspaceId(id)) and this project's repoKey
    // now resolves, MIGRATE its registry row + messages into store/<repoKey>/ and
    // rewrite ownerKey=repoKey BEFORE the ownership check below — so ensure no
    // longer rejects the workspace from its own inbox. Lock already held.
    let rehomed = null;
    {
      const storedOwnerKeyPre = typeof existing.ownerKey === 'string' && existing.ownerKey ? existing.ownerKey : null;
      const hashKey = store.hashFromWorkspaceId(id);
      if (currentRepoKey && storedOwnerKeyPre === hashKey && hashKey !== currentRepoKey) {
        rehomed = rehomeCore(home, id, currentRepoKey, ctx);
        if (rehomed && rehomed.rehomed) existing = readDescriptorFile(home, id) || existing;
      }
    }
    const currentOwnerKey = currentRepoKey || store.hashFromWorkspaceId(id);
    const storedOwnerKey = typeof existing.ownerKey === 'string' && existing.ownerKey ? existing.ownerKey : null;
    const provenOwnerKey = storedOwnerKey || descriptorStructuralRepoKey(existing);
    const activeLegacyPerId = !storedOwnerKey && !provenOwnerKey && currentRepoKey === null;
    if ((!provenOwnerKey && !activeLegacyPerId) || (provenOwnerKey && provenOwnerKey !== currentOwnerKey)) {
      return { ok: false, error: 'existing descriptor does not belong to the current project' };
    }
    const ensured = Object.assign({}, existing);
    if (!storedOwnerKey) ensured.ownerKey = currentOwnerKey;
    if (currentRepoKey && descriptorFreshRepoKey(ensured) === currentRepoKey) ensured.repoKey = currentRepoKey;
    writeDescriptorAtomic(home, id, ensured);
    existing = ensured;
    precreateCursorAndInbox(existing);
    upsertStoreRegistry(home, existing, ctx);
    const retire = retireWorktreeDuplicates(home, existing, ctx);
    const out = { ok: true, action: 'exists', id, descriptor: existing };
    if (rehomed && rehomed.rehomed) out.rehomed = { movedMessages: rehomed.movedMessages, movedRegistry: rehomed.movedRegistry };
    if (retire) { out.retiredDuplicates = retire.retired; out.forwardedMessages = retire.forwarded; if (retire.left) out.leftDuplicates = retire.left; if (retire.forwardFailed) out.forwardFailed = retire.forwardFailed; }
    return out;
  }
  const desc = buildDescriptorFromFlags(id, flags, existing, ctx.env);
  // Validate the REQUIRED workspace fields before writing. A descriptor missing
  // worktreePath/sessionId is invisible to the supervisor (readDescriptors filters
  // on both), so writing one with null fields and returning ok:true is a silent
  // phantom-registration. `register` (and `ensure` when it CREATES a new
  // descriptor) therefore require them; the flag values may come from `existing`
  // on a re-register/update, so we validate the MERGED result, not the raw flags.
  const missing = [];
  if (!desc.worktreePath) missing.push('--worktree');
  if (!desc.sessionId) missing.push('--session');
  if (missing.length) {
    return {
      ok: false,
      error: 'register requires ' + missing.join(' and ')
        + ' (required workspace fields; a descriptor without them is ignored by the supervisor)',
    };
  }
  const currentRepoKey = repoKeyForCwd(ctx);
  const worktreeRepoKey = descriptorFreshRepoKey(desc);
  // P1-6 CROSS-PROJECT GUARD: reject a register whose --worktree lives in a
  // DIFFERENT git project than the invoking cwd. Both keys must resolve AND
  // differ to reject (a null on either side is the legitimate transient-null or
  // non-git case handled elsewhere) — otherwise repoA could register repoB's
  // descriptor with ownerKey=A, letting A's reap/reconcile archive B's workspace.
  if (currentRepoKey && worktreeRepoKey && currentRepoKey !== worktreeRepoKey) {
    return {
      ok: false,
      error: 'register --worktree ' + JSON.stringify(desc.worktreePath)
        + ' belongs to a different project (' + worktreeRepoKey + ') than the current cwd (' + currentRepoKey
        + ') — cross-project registration is refused',
    };
  }
  if (currentRepoKey && worktreeRepoKey === currentRepoKey) desc.repoKey = currentRepoKey;
  desc.ownerKey = currentRepoKey || store.hashFromWorkspaceId(id);
  writeDescriptorAtomic(home, id, desc);
  precreateCursorAndInbox(desc);
  // F-B (v0.61.2): re-registering an EXISTING id at a NEW same-project worktree
  // is a legitimate supported flow (cross-project is already rejected above by
  // the P1-6 guard) — pass allowPathChange:true so the F2 id-collision guard
  // does not silently skip the registry write while the descriptor above has
  // already moved to the new path, which would leave them divergent. Check the
  // return: false means the store genuinely skipped the write (should not
  // happen with allowPathChange:true short of a store-internal bug) — never
  // report ok:true over an unconfirmed registry write.
  const registryWritten = upsertStoreRegistry(home, desc, ctx, { allowPathChange: true });
  if (registryWritten === false) {
    return {
      ok: false, id,
      error: 'registry upsert was skipped for ' + JSON.stringify(id)
        + ' — descriptor and registry are now out of sync (retry required)',
    };
  }
  // Retire any legacy/phantom duplicate row for this SAME worktree so exactly one
  // row (this builder-id — the partition the child reads) survives, forwarding the
  // duplicate's unread backlog first (no orphaned messages). No-op unless a
  // duplicate exists; gated to builder-id self-registers inside the helper.
  const retire = retireWorktreeDuplicates(home, desc, ctx);
  const out = { ok: true, action: existing ? 'updated' : 'registered', id, descriptor: desc };
  if (retire) { out.retiredDuplicates = retire.retired; out.forwardedMessages = retire.forwarded; if (retire.left) out.leftDuplicates = retire.left; if (retire.forwardFailed) out.forwardFailed = retire.forwardFailed; }
  return out;
  });
}

function cmdHeartbeat(id, flags, ctx) {
  const home = ctx.home;
  const dir = heartbeatsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const progressRaw = one(flags, 'progress');
  let progress = null;
  if (progressRaw !== undefined) {
    const n = Number(progressRaw);
    if (Number.isFinite(n)) progress = Math.max(0, Math.min(100, n));
  }
  // Only assert what the caller actually supplied (heartbeat authorship rule:
  // never fabricate progress/phase/wip/blockers — absent = unknown = null/[]).
  const beat = {
    id,
    ts: now,
    state_ts: now,
    source: 'cli-heartbeat',
    progress_pct: progress,
    phase: one(flags, 'phase') !== undefined ? one(flags, 'phase') : null,
    wip: many(flags, 'wip'),
    blockers: many(flags, 'blockers'),
    sessionId: one(flags, 'session') !== undefined ? one(flags, 'session') : null,
  };
  const p = path.join(dir, id + '.json');
  // P2-10: a UNIQUE staged temp per write (pid + hrtime + an in-process counter)
  // — a shared `<id>.json.tmp` let two concurrent heartbeats race, one rename
  // consuming the other's temp -> ENOENT. Uniqueness is derived from
  // process.pid + process.hrtime.bigint() (monotonic, per-process) + a counter,
  // deliberately NOT Math.random()/Date.now() (constrained/collision-prone here).
  const tmp = p + '.' + process.pid + '.' + process.hrtime.bigint().toString(36) + '.' + (heartbeatTmpCounter++) + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(beat));
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {} // never leak a staged temp on failure
    throw e;
  }

  // P2-11: compute `pending` the SAME way computeLiveness does on its fresh-
  // heartbeat short-circuit (liveness.js: `hbBacklog.known && lines.length>0`) so
  // the two verdict-write paths AGREE — the old hardcoded `pending:false` here
  // disagreed with the supervisor's recompute, flapping the parent-gate signal.
  let pending = false;
  try {
    const descForPending = readDescriptorFile(home, id);
    if (descForPending) {
      const backlog = unreadBacklog(descForPending.inboxPath, descForPending.cursorPath);
      pending = !!(backlog.known && backlog.lines.length > 0);
    }
  } catch (_) { pending = false; /* fail-open: pending defaults to false on any read error */ }

  // v0.62 heartbeat-alive decouple (owner-approved — see liveness.js header): a
  // heartbeat is emitted only by this workspace's OWN live session, so receiving
  // one is definitive proof the env is ALIVE. Immediately CLEAR the persisted
  // liveness verdict to `alive` (resetting any stale/nudged/escalated flag +
  // nudge attempts) so the parent-gate and roster reflect liveness at once,
  // without waiting for the next supervisor sweep. The verdict's own
  // fresh-heartbeat short-circuit keeps it alive on subsequent recomputes.
  // Fail-open: an unsafe id (writeVerdict throws) or any fs error is swallowed —
  // the base heartbeat above already succeeded and must remain non-fatal.
  try {
    writeVerdict(id, {
      status: 'alive', lastOutboundTs: now, staleSince: null,
      nudgeAttempts: 0, nudgedAt: null, pending, heartbeatTs: now,
    }, home);
  } catch (_) { /* fail-open: verdict refresh is best-effort, never breaks a heartbeat */ }

  // v0.57 mesh (PLAN-v0.57-mesh.md D11/D22, Phase 4 step 4): `--summary TEXT`
  // ALSO broadcasts a mesh heartbeat row into THIS project's SHARED
  // store/<repoKey>/ — `mtype='broadcast'` + `is_heartbeat=1` (D22; never a
  // third mtype value), so it tiers as a broadcast and NEVER Stop-gates, and is
  // EXCLUDED from `broadcastUnread` (else every peer's per-turn heartbeat would
  // grow that counter forever). `sender` is set to `id` — the BUILDER-ID this
  // heartbeat is FOR (matching `deriveSummary`'s `working_on` match on
  // `sender===d.id`) — deliberately NOT `callerIdentity()`/meshId, a DIFFERENT
  // addressing handle (D19). The summary text is caller-supplied ONLY, never
  // defaulted/fabricated (D11 heartbeat authorship rule); omitting --summary is
  // a legacy no-op (back-compat, no mesh write at all). A non-git cwd (repoKey
  // null, O-D5 "mesh dormant") is NOT an error — the base heartbeat above still
  // succeeds; `meshBroadcast` reports why the mesh write was skipped.
  let meshBroadcast = null;
  const summaryText = one(flags, 'summary');
  if (summaryText !== undefined) {
    const cwd = ctx.cwd || process.cwd();
    const repoKey = repokey.repoKeyForWorktree(cwd);
    if (!repoKey) {
      meshBroadcast = { ok: false, reason: 'no-project' };
    } else {
      const urgencyRaw = one(flags, 'urgency');
      const urgency = urgencyRaw !== undefined ? urgencyRaw : 'low';
      if (!ALLOWED_URGENCY.includes(urgency)) {
        meshBroadcast = {
          ok: false,
          error: 'heartbeat --urgency must be one of ' + ALLOWED_URGENCY.join('|'),
          allowed: ALLOWED_URGENCY.slice(),
        };
      } else {
        const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
        try {
          // P0 fix: `sender: id` above feeds recent[]/alreadyReportedThisEpisode()
          // (hooks/devswarm-child-gate.js's Stop-gate satisfaction check) — an
          // unvalidated `id` let ANY workspace forge another's "already reported"
          // row (`node devswarm.js heartbeat <victim-id> --summary ...`), spoofing
          // the victim's Stop-gate closed without it ever reporting. Same
          // provable-ownership check cmdSend (D18) and cmdInboxMessages' ack path
          // (D26) already use: literal self, or the caller's OWN registry entry
          // (joined by worktree-derived meshId via resolveMeshTarget) carries `id`
          // as its registered id.
          const callerInfo = callerIdentityDetailed(ctx.env, cwd);
          const caller = callerInfo.identity;
          const ownEntry = resolveMeshTarget(s, caller);
          const owns = caller === id || (ownEntry && ownEntry.id === id);
          if (!owns) {
            // A7: name WHICH leg failed instead of one generic message for
            // an unresolvable identity, an unregistered caller, AND a genuine
            // mismatch alike.
            const cause = ownershipRefusalCause(callerInfo.kind, ownEntry);
            meshBroadcast = {
              ok: false,
              reason: cause,
              error: 'heartbeat --summary refused (' + cause + '): caller ' + JSON.stringify(caller)
                + ' does not own workspace ' + JSON.stringify(id),
              callerIdentity: caller,
            };
          } else {
            const fields = { from: id, to: null, type: 'broadcast', message: String(summaryText), timestamp: now, urgency };
            const hash = store.meshMessageHash(fields);
            const res = store.appendMeshMessage(s, Object.assign({}, fields, { hash, isHeartbeat: true }));
            store.deriveSummary(s, { home, env: ctx.env, now });
            meshBroadcast = { ok: true, sent: !!res.inserted, seq: res.seq, repoKey };
          }
        } finally { s.close(); }
      }
    }
  }
  // P1 fix: cmdHeartbeat's top-level `ok` (and therefore the CLI exit code —
  // see the 'heartbeat' dispatcher case's `code: r.ok ? 0 : 2`) used to be
  // hardcoded `true` regardless of `meshBroadcast`'s outcome, so a genuinely
  // BAD invocation (e.g. `--urgency bogus`) still reported success end-to-end
  // — invisible to any standard exit-code check. Fold in a HARD meshBroadcast
  // failure (any `ok:false` whose `reason` is not in the deliberately-benign
  // BENIGN_MESH_BROADCAST_REASONS set above) so a real caller mistake is no
  // longer silently masked, while the two documented/tested benign shapes
  // (no-project dormancy, ownership-refusal-as-security-control) keep the
  // base heartbeat reporting `ok:true`, unchanged.
  const hardMeshFailure = !!(meshBroadcast && meshBroadcast.ok === false
    && !BENIGN_MESH_BROADCAST_REASONS.has(meshBroadcast.reason));
  return { ok: !hardMeshFailure, action: 'heartbeat', id, heartbeat: beat, meshBroadcast };
}

// cmdInboxPull(id, flags, ctx) — child-side reception drain. AUTO-ENSURES the
// descriptor (idempotent — reuses cmdRegister's write + cursor-init path with
// requireNew so an existing descriptor is left intact) so a child can pull without
// a prior explicit register, then runs ONE bounded, guard-safe pullOnce (native
// message-count gate -> at-most-one bounded read-messages -> atomic durable NDJSON
// append + store parity). Defaults: worktreePath = ctx.cwd || cwd; sessionId from
// --session / DEVSWARM_BUILDER_ID env / the id; inbox + cursor under the devswarm
// root; cursor initialized to 0.
function cmdInboxPull(id, flags, ctx) {
  const home = ctx.home;
  const root = devswarmRoot(home);
  // A6 fix: when NEITHER an explicit --session NOR DEVSWARM_BUILDER_ID names a
  // real session, do NOT mint the sessionId from `id` itself (that made a
  // bare, un-claimed auto-ensured/reconcile-spawned registry seed read as
  // permanently "live" everywhere liveness is checked, since `sessionId`
  // is the ONLY liveness signal — e.g. resolveMeshTarget could then route a
  // `send` to a partition nothing actually drains). Fall back to the
  // SYNTHETIC_SESSION_PREFIX marker instead: still non-empty/truthy (so
  // cmdRegister's own "register requires --session" validation is satisfied
  // and the descriptor stays writable/visible to the supervisor), but
  // isLiveSessionId() explicitly excludes this exact prefix, so every
  // liveness-driven mesh primitive in this file correctly treats this row as
  // NOT live until a real session (a genuine --session or
  // DEVSWARM_BUILDER_ID) claims it.
  const session = one(flags, 'session')
    || (ctx.env && ctx.env.DEVSWARM_BUILDER_ID)
    || (SYNTHETIC_SESSION_PREFIX + id);
  // Register the RESOLVED git worktree, NOT the raw cwd — the SAME canonical
  // primitive callerIdentity uses (resolveCallerWorktree). A child that runs
  // `inbox pull` from a git SUBDIRECTORY must register the toplevel, so the
  // stored worktreePath hashes to the SAME meshId a later `send --to <its-meshId>`
  // resolves against (resolveMeshTarget hashes d.worktreePath). Registering the
  // raw subdir instead hashed to a DIFFERENT meshId, so the child failed closed
  // as `unregistered-recipient` and was unaddressable by mesh. Fall back to the
  // raw cwd ONLY for the non-git case (no toplevel resolves) — preserves the
  // existing raw-cwd behavior a non-git daemon/unit relies on.
  const rawCwd = ctx.cwd || process.cwd();
  const worktree = resolveCallerWorktree(rawCwd) || rawCwd;
  const ensureFlags = {
    worktree: [worktree],
    session: [session],
    inbox: [pull.inboxDefaultPath(home, id)],
    cursor: [pull.cursorDefaultPath(home, id)],
  };
  // requireNew: idempotent — leaves an existing descriptor (and its inboxPath)
  // untouched; only CREATES one when absent. Ownership failure must stop the
  // pull before it reads or mutates the inbox.
  const ensured = cmdRegister(id, ensureFlags, ctx, { requireNew: true });
  if (!ensured.ok) return Object.assign({}, ensured, { action: 'pull', id });
  // ctx.io is undefined in production (real hivecontrol spawn); tests inject
  // { run } so the CLI path is exercised without touching a real binary — same
  // injection posture as ctx.backend / ctx.now / ctx.env already use. `cwd`
  // (v0.57 mesh D1/D8) lets pullOnce's parity feed derive this project's
  // repoKey and land the child's drained messages in the SHARED store.
  const res = pull.pullOnce({ home, id, env: ctx.env, backend: ctx.backend, now: ctx.now, cwd: worktree, io: ctx.io });
  const out = {
    ok: !!res.ok, action: 'pull', id,
    imported: res.imported || 0, duplicate: res.duplicate || 0,
    nativeCount: res.nativeCount || 0, locked: !!res.locked,
    // P1 fix: pullOnce's loss check (devswarm-pull.js) sets `lost` when the
    // native message-count exceeds what actually landed durably — this MUST
    // survive the subprocess boundary (cmdReconcile spawns this exact verb
    // and parses its stdout JSON) or a real shortfall silently vanishes
    // before the reconciler ever sees it.
    lost: res.lost || 0,
  };
  if (res.error) out.error = res.error;
  return out;
}

// cmdInboxMessages(id, flags, ctx, {ack}) — the Primary/store READ path. Reads
// message BODIES directly from the store via store.listMessages (NON-destructively —
// it never drains the native queue or deletes a row), mirroring how child-side
// `inbox read` reads the durable NDJSON. `--unread` returns only messages past the
// durable ACK cursor (a bare-int file under cursors/); `ack` (the `read-primary`
// ergonomic, or `--ack`) advances that cursor to the current total. Needs NO
// descriptor — the store rows exist keyed by workspaceId regardless. `--json` is
// accepted for parity (the CLI always emits JSON) and otherwise ignored.
//
// #22 fix: on ack, ALSO advance the STORE's own cursor (store.setCursor) — not just
// the durable ACK cursor FILE under cursors/. deriveSummary()'s projected `unread`
// (what the parent table shows) is computed from the store cursor
// (store.cursorValue), NOT the ACK cursor file, so without this a Primary that read
// its inbox still showed those messages as unread forever. Both cursors are kept:
// the ACK cursor file stays the read-guard ALLOW-listed location; the store cursor
// is the summary projection's source of truth. Re-derive summary.json in the same
// call so the persisted projection reflects the drop immediately, not just on the
// next unrelated store write.
//
// Cross-workspace ack hazard (bug #2): this path needs no descriptor and, before
// this fix, accepted ANY id — so workspace A could `inbox messages B --ack` (or
// `read-primary B`) and silently advance B's cursor, marking B's own unread as
// read out from under it. Harmless under today's usage but a live footgun once
// "all can read all" is common (an observer that reflexively acks someone else's
// id destroys the owner's unread signal). READ WITHOUT --ack stays OPEN to any id
// on purpose (that is the cross-workspace visibility feature) — only the ack
// (mutating) path is gated. `--ack-as-owner` is the explicit operator override for
// a legitimate cross-workspace ack (e.g. a supervisor clearing a dead workspace's
// backlog on its behalf).
// resolveWorkspaceStoreForRead(id, ctx, home) -> { ok:true, store } | { ok:false, ... }.
// The shared "which physical mesh-store partition does `id` live in" resolution —
// re-homes a stranded legacy-hash row into its cwd project store first (P1-1/P1-2),
// then refuses when `id` is POSITIVELY registered under a DIFFERENT project than
// this invocation's own cwd resolves to (A1(c) — never silently open the wrong
// store). Extracted from cmdInboxMessages (the Primary/store read path) verbatim,
// unchanged behavior, so cmdInbox's descriptor-path count/read/ack (P0 fix: a
// `send --to` direct is STORE-ONLY and must be visible from `inbox read`/`count`
// too, not just `inbox messages`/`read-primary`) opens `id`'s mesh partition the
// SAME way instead of re-implementing (and potentially drifting from) this guard.
function resolveWorkspaceStoreForRead(id, ctx, home) {
  // P1-1/P1-2 RE-HOME (read path): if this workspace is still stranded in the
  // legacy hash bucket (persisted ownerKey=hash) while repoKey now resolves, its
  // messages are in a bucket the repoKey-keyed read below would never open — a
  // silent black hole. Migrate them (registry row + backlog + cursor) into
  // store/<repoKey>/ FIRST so the read that follows actually sees them. Best-
  // effort + under the per-id lock; a no-op when not stranded.
  try { maybeRehomeToCwdProject(home, id, ctx); } catch (_) { /* fail-open: read proceeds regardless */ }
  // A1(c) fix: repoKeyForCwd(ctx) collapsing to null must not silently open a
  // DIFFERENT store than the one `id` is ACTUALLY registered under. Compare
  // against `id`'s own descriptor (when one exists) — its structurally-derived
  // repoKey (descriptorFreshRepoKey, re-derived from the descriptor's real,
  // current worktreePath — the SAME independently-verifiable ground truth
  // rehomeMiskeyedRow uses) names which project `id` genuinely belongs to.
  // Only refuse when that ground truth POSITIVELY names a real, resolvable
  // project this invocation's own repoKey resolution does NOT agree with —
  // this is the concrete symptom the review names: a caller whose OWN cwd
  // resolution fails/drifts (a submodule miscount, an invocation from the
  // wrong directory, git transiently unavailable) silently falls back to the
  // legacy per-id hash bucket and reports `ok:true, total:0, messages:[]`,
  // reading as "not registered" for a workspace that IS registered elsewhere.
  // An id with NO descriptor, or whose descriptor's own worktree is itself
  // unresolvable (the legacy/no-project mode this CLI has always supported,
  // exercised extensively by this suite's default non-git `ctx()` cwd), is
  // UNCHANGED — this must never turn the sanctioned "no project at all"
  // fallback into a hard failure.
  const callerRepoKeyForRead = repoKeyForCwd(ctx);
  const descForRead = readDescriptorFile(home, id);
  const descRepoKeyForRead = descForRead ? descriptorFreshRepoKey(descForRead) : null;
  if (descRepoKeyForRead && descRepoKeyForRead !== callerRepoKeyForRead) {
    return {
      ok: false, id,
      reason: 'project-context-mismatch',
      error: 'workspace ' + JSON.stringify(id) + ' is registered under project ' + JSON.stringify(descRepoKeyForRead)
        + (callerRepoKeyForRead
          ? (', but the current context resolves to a DIFFERENT project ' + JSON.stringify(callerRepoKeyForRead))
          : ', but the current context could not resolve a project (non-git cwd?)')
        + ' — run this from within that project\'s worktree to read its inbox',
    };
  }
  // v0.57 mesh (D24): this opens the SAME shared per-project store the per-project
  // ingest daemon natively drains INTO (D8/D21) — without this re-key, a reader
  // would open the legacy per-id bucket the daemon no longer writes to and
  // silently see nothing.
  const s = store.openStore({ home, workspaceId: id, hash: callerRepoKeyForRead || undefined, backend: ctx.backend, env: ctx.env });
  return { ok: true, store: s };
}

// ndjsonHashesFromLines(lines) -> Set<string> of each parsed line's embedded `_h`
// content hash (devswarm-pull.js pullOnce writes `{_h, fromBranch, message,
// createdAt, status}` per NDJSON line). An unparsable/hashless line contributes
// nothing — it can never dedupe-match a store row and is never dropped itself
// (callers keep `lines` as-is; this Set is only used to exclude STORE rows that
// duplicate it).
function ndjsonHashesFromLines(lines) {
  const set = new Set();
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && o._h != null) set.add(String(o._h));
    } catch (_) { /* unparsable line: no hash to dedupe against, never thrown */ }
  }
  return set;
}

// ndjsonAllHashes(inboxPath) -> Set<string> of EVERY line's `_h` in the durable
// NDJSON (not just the unread tail) — used for the `total` union so an
// already-consumed native-drained message (still on disk, past the cursor) isn't
// double-counted against its store-side parity-fed twin. Fail-soft: an absent/
// unreadable inbox yields an empty Set (matches inboxCursor.countMessages'
// own fail-soft contract).
function ndjsonAllHashes(inboxPath) {
  let raw;
  try { raw = String(fs.readFileSync(inboxPath, 'utf8')); } catch (_) { return new Set(); }
  const set = new Set();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && o._h != null) set.add(String(o._h));
    } catch (_) { /* unparsable line: contributes no hash, never thrown */ }
  }
  return set;
}

function cmdInboxMessages(id, flags, ctx, opts) {
  const home = ctx.home;
  const doAck = !!((opts && opts.ack) || flags.ack);
  const unread = !!flags.unread || doAck; // read-primary is inherently unread-then-ack
  const ackAsOwner = !!flags['ack-as-owner'];
  // Claim 4 (ack-as-owner UX guard): `--ack-as-owner` is ONLY meaningful on a
  // MUTATING ack (it bypasses the cross-workspace ownership gate below). On the
  // non-acking `inbox messages` read path (no --ack, not the read-primary
  // wrapper) the flag reads as "ack on someone's behalf" but does NOTHING — a
  // silent no-op that leaves the operator believing the backlog was cleared.
  // Warn to stderr (non-fatal, control-flow unchanged: this stays a pure read)
  // and point at the verb that actually acks.
  if (ackAsOwner && !doAck) {
    try {
      process.stderr.write('[devswarm] inbox messages ' + JSON.stringify(String(id))
        + ' --ack-as-owner did NOT ack — `messages` is read-only. To ack on the'
        + " owner's behalf use `inbox read-primary " + String(id)
        + ' --ack-as-owner` (or add --ack).\n');
    } catch (_) {}
  }
  const cursorPath = primaryCursorPath(home, id);
  const cursor = inboxCursor.readCursor(cursorPath);
  const openedForRead = resolveWorkspaceStoreForRead(id, ctx, home);
  if (!openedForRead.ok) return openedForRead;
  const s = openedForRead.store;
  let total, messages, acked;
  try {
    if (doAck && !ackAsOwner) {
      const callerInfo = callerIdentityDetailed(ctx.env, ctx.cwd);
      const caller = callerInfo.identity;
      const callerKind = callerInfo.kind;
      // v0.57 mesh (P0 fix): literal `caller !== id` only holds when the caller's
      // OWN registered store id equals its worktree-derived meshId — true for a
      // self-registered Primary, but NEVER true for a child (registered under its
      // hivecontrol DEVSWARM_BUILDER_ID, a UUID unrelated to meshId — see
      // docs/KB-devswarm-hivecontrol.md:215). Every real child was refused
      // reading/acking its OWN inbox by this literal check. Resolve PROVABLE
      // ownership instead: does the caller's OWN registry entry — found via the
      // SAME worktree-matching join `resolveMeshTarget` already performs for send
      // addressing (compare each entry's worktreePath-derived meshId to the
      // caller's meshId) — carry `id` as ITS registered id? If so the caller,
      // whatever free-form id it registered under, IS the owner of `id`'s
      // partition (it is running from that exact worktree). A genuinely different
      // workspace's cwd resolves to a DIFFERENT registry entry (or none), so this
      // stays fail-closed for real cross-workspace acks — preserving the v0.56
      // cross-workspace ack-hazard protection (bug #2) this guard exists for.
      const ownEntry = resolveMeshTarget(s, caller);
      const owns = caller === id || (ownEntry && ownEntry.id === id);
      if (!owns) {
        // A7: name WHICH leg failed (same classification as the heartbeat
        // --summary refusal above).
        const cause = ownershipRefusalCause(callerKind, ownEntry);
        return {
          ok: false,
          reason: cause,
          error: 'ack refused (' + cause + '): caller ' + JSON.stringify(caller) + ' does not own workspace '
            + JSON.stringify(id) + ' (pass --ack-as-owner to override)',
          id,
          callerIdentity: caller,
        };
      }
    }
    total = s.messageCount(id);
    messages = s.listMessages(id, { sinceCursor: unread ? cursor : 0 });
    if (doAck) {
      acked = inboxCursor.ackTo(cursorPath, total); // absolute set to the current total (no inbox clamp)
      s.setCursor(id, acked); // keep deriveSummary's unread projection in sync with the ACK
      store.deriveSummary(s, { home, env: ctx.env, now: ctx.now }); // refresh the persisted projection now
    }
  } finally { s.close(); }
  return {
    ok: true,
    action: doAck ? 'read-primary' : 'messages',
    id,
    unread,
    cursor: acked !== undefined ? acked : cursor,
    total,
    count: messages.length,
    messages,
  };
}

function cmdInbox(sub, id, flags, ctx) {
  const home = ctx.home;
  if (sub === 'pull') return cmdInboxPull(id, flags, ctx);
  if (sub === 'messages') return cmdInboxMessages(id, flags, ctx);
  if (sub === 'read-primary') return cmdInboxMessages(id, flags, ctx, { ack: true });
  const desc = readDescriptorFile(home, id);
  if (!desc || !desc.inboxPath) {
    return { ok: false, error: 'no inboxPath for workspace ' + JSON.stringify(id) + ' (register it first)' };
  }
  const inboxPath = desc.inboxPath;
  const cursorPath = desc.cursorPath;
  if (sub === 'count' || sub === 'read' || sub === 'ack') {
    // P0 fix (parent->child direct messages silently undeliverable): `send --to`
    // (cmdSend/appendMeshMessage) is a STORE-ONLY write — it never touches this
    // descriptor's durable NDJSON, which is populated ONLY by `inbox pull` draining
    // the NATIVE hivecontrol queue (devswarm-pull.js pullOnce). When native
    // hivecontrol messaging is unavailable, nothing ever writes the NDJSON, so a
    // mesh-direct message sent to `id` was invisible to `inbox count/read/ack`
    // even though `inbox messages <id>` (the store-direct read) saw it immediately.
    // LOSS-FREE UNION (not winner-take-all): merge in the STORE's messages for
    // `id`, deduped by content hash against the NDJSON side — a native-drained
    // message carries the SAME `native:`-prefixed hash in both channels (see
    // devswarm-ingest.js messageHash / devswarm-pull.js's `_h` field and its
    // best-effort store-parity feed), so it is correctly excluded from the
    // store-only tally; a mesh-direct `send --to` message exists ONLY in the
    // store (`mesh:`-prefixed hash) and is therefore always additive here.
    // Best-effort: any store-open failure (e.g. a genuine cross-project id
    // mismatch) falls back to the PRE-fix NDJSON-only reporting — count/read
    // never newly hard-fail because of this merge.
    const u = inboxCursor.readUnread(inboxPath, cursorPath);
    let storeHandle = null;
    let storeCursorVal = 0;
    let storeOnlyUnreadRows = [];
    let storeOnlyTotalCount = 0;
    try {
      const opened = resolveWorkspaceStoreForRead(id, ctx, home);
      if (opened.ok) {
        storeHandle = opened.store;
        storeCursorVal = storeHandle.cursorValue(id);
        const allNdjsonHashes = ndjsonAllHashes(inboxPath);
        const unreadNdjsonHashes = ndjsonHashesFromLines(u.lines);
        const storeAllRows = storeHandle.listMessages(id);
        storeOnlyTotalCount = storeAllRows.filter((r) => !r.hash || !allNdjsonHashes.has(r.hash)).length;
        const storeUnreadRows = storeHandle.listMessages(id, { sinceCursor: storeCursorVal });
        storeOnlyUnreadRows = storeUnreadRows.filter((r) => !r.hash || !unreadNdjsonHashes.has(r.hash));
      }
    } catch (_) { /* fail-open: NDJSON-only reporting, matches pre-fix behavior */ }

    const mergedTotal = u.total + storeOnlyTotalCount;
    const mergedUnreadCount = u.lines.length + storeOnlyUnreadRows.length;

    if (sub === 'count') {
      if (storeHandle) storeHandle.close();
      return {
        ok: true, action: 'count', id,
        unread: mergedUnreadCount, cursor: u.cursor, total: mergedTotal, known: u.known,
        storeCursor: storeCursorVal, storeUnread: storeOnlyUnreadRows.length,
      };
    }
    if (sub === 'read') {
      if (storeHandle) storeHandle.close();
      return {
        ok: true, action: 'read', id,
        lines: u.lines, meshMessages: storeOnlyUnreadRows,
        count: mergedUnreadCount, cursor: u.cursor, total: mergedTotal, known: u.known,
        storeCursor: storeCursorVal,
      };
    }
    // sub === 'ack'
    if (!cursorPath) { if (storeHandle) storeHandle.close(); return { ok: false, error: 'no cursorPath for workspace ' + JSON.stringify(id) }; }
    const toRaw = one(flags, 'to');
    let cursor;
    if (toRaw !== undefined) {
      const n = Number(toRaw);
      if (!Number.isFinite(n)) { if (storeHandle) storeHandle.close(); return { ok: false, error: '--to must be a number' }; }
      // `--to N` stays NDJSON-SCOPED, byte-for-byte unchanged from the pre-fix
      // contract: an absolute NDJSON line-count has no cross-channel meaning for
      // the store's own cursor, so ack-all (below) is the only path that also
      // clears the store side.
      cursor = inboxCursor.ackTo(cursorPath, n, undefined, inboxPath);
    } else {
      cursor = inboxCursor.advanceCursor(inboxPath, cursorPath); // ack-all (ndjson side)
      // Store-side ack-all (P0 fix): advance the STORE's OWN cursor for `id` too,
      // so deriveSummary's persisted projection (what the parent-gate banner
      // reads) agrees with what this read path just reported as consumed —
      // otherwise the banner would keep declaring these messages unread forever
      // even after the recipient legitimately read+acked them. Gated by the SAME
      // ownership guard `inbox messages --ack`/`read-primary` already enforce
      // (cross-workspace ack hazard, bug #2) since this is a NEW mutation this
      // verb never performed before; `--ack-as-owner` overrides identically for a
      // legitimate cross-workspace ack (e.g. a supervisor clearing a dead
      // workspace's backlog on its behalf). A refusal here is silent/best-effort
      // — the NDJSON ack above already durably succeeded regardless.
      if (storeHandle) {
        try {
          const ackAsOwner = !!flags['ack-as-owner'];
          let owns = true;
          if (!ackAsOwner) {
            const callerInfo = callerIdentityDetailed(ctx.env, ctx.cwd);
            const caller = callerInfo.identity;
            const ownEntry = resolveMeshTarget(storeHandle, caller);
            owns = caller === id || (ownEntry && ownEntry.id === id);
          }
          if (owns) {
            const totalNow = storeHandle.messageCount(id);
            storeHandle.setCursor(id, totalNow);
            // Keep the SEPARATE `inbox messages --ack`/`read-primary` ACK-cursor
            // FILE (primaryCursorPath, a DIFFERENT namespace than this
            // descriptor's own cursorPath) in lockstep too, so a workspace that
            // mixes `inbox ack` with `read-primary` never sees those two
            // read-verbs disagree about what is already consumed.
            inboxCursor.ackTo(primaryCursorPath(home, id), totalNow);
            store.deriveSummary(storeHandle, { home, env: ctx.env, now: ctx.now });
          }
        } catch (_) { /* best-effort: the ndjson ack above already durably succeeded */ }
      }
    }
    if (storeHandle) storeHandle.close();
    return { ok: true, action: 'ack', id, cursor, total: inboxCursor.countMessages(inboxPath) };
  }
  return { ok: false, error: 'unknown inbox subcommand: ' + JSON.stringify(sub) + ' (read|ack|count|pull|messages|read-primary)' };
}

// cmdRegisterPrimary(flags, ctx) — register the CURRENT worktree's Primary/parent
// workspace descriptor under its per-worktree workspaceId (primary-<worktreeHash>),
// so `migrate` can fold a legacy NDJSON inbox into the store under that same id (what
// lets a Primary import its stranded messages). Reuses cmdRegister's descriptor-write
// path (validation + store upsert + cursor init). worktree defaults to the git
// toplevel of ctx.cwd; --inbox optionally points at a legacy NDJSON source for migrate.
function cmdRegisterPrimary(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const worktree = one(flags, 'worktree') || inst.resolveWorktree(cwd);
  if (!worktree) {
    return { ok: false, error: 'register-primary must run inside a git worktree (or pass --worktree <path>)' };
  }
  const id = inst.primaryWorkspaceId(worktree);
  if (!isSafeId(id)) return { ok: false, error: 'derived primary workspace id is unsafe: ' + JSON.stringify(id) };
  const session = one(flags, 'session') || (ctx.env && ctx.env.DEVSWARM_BUILDER_ID) || id;
  const inbox = one(flags, 'inbox'); // optional legacy NDJSON source for `migrate`
  const cursor = one(flags, 'cursor') || primaryCursorPath(home, id);
  const ensureFlags = { worktree: [worktree], session: [session], cursor: [cursor] };
  if (inbox !== undefined) ensureFlags.inbox = [inbox];
  const r = cmdRegister(id, ensureFlags, ctx);
  if (!r.ok) return r;
  return { ok: true, action: 'register-primary', id, workspaceId: id, worktree, descriptor: r.descriptor };
}

function cmdWorkspacesList(flags, ctx) {
  const home = ctx.home;
  // PER-PROJECT: which project's store to derive. Explicit targeting wins so a
  // caller can inspect any project's summary: --workspace <id> (a store partition
  // key directly) or --worktree <path> (its primary-<hash>). Otherwise derive the
  // CURRENT worktree's own store (primary-<worktreeHash>) from cwd. Outside a
  // worktree with no flag, fall back to the default bucket (an empty/legacy view).
  let workspaceId = one(flags, 'workspace');
  const worktreeFlag = one(flags, 'worktree');
  const worktree = worktreeFlag || inst.resolveWorktree(ctx.cwd || process.cwd());
  if (workspaceId === undefined) {
    workspaceId = worktree ? inst.primaryWorkspaceId(worktree) : undefined;
  }
  // v0.57 mesh (D24 store-caller re-key — this call was missed by the original
  // sweep): target the SAME shared per-project store `register`/`roster`/`gate`/
  // `archive` all write into (repoKey, when resolvable) — else `workspaces list`
  // opens the legacy per-id hash bucket while every writer lands in store/<repoKey>/,
  // so a freshly-registered peer never shows up here (count:0 against a real
  // roster). Derived from the SAME `worktree` used to derive `workspaceId` above
  // (an explicit --worktree flag, when given, must win over ctx.cwd for BOTH —
  // repoKeyForCwd(ctx) alone would ignore the flag and resolve the wrong
  // project's repoKey whenever the caller's cwd differs from --worktree, e.g. a
  // subprocess invocation that targets another worktree by flag). Omitting
  // `workspaceId` from deriveSummary lets it fall back to the opened handle's
  // own `.hash` (the repoKey) instead of recomputing hashFromWorkspaceId(workspaceId)
  // and re-targeting the legacy bucket.
  const repoKey = worktree ? repokey.repoKeyForWorktree(worktree) : repoKeyForCwd(ctx);
  // GH1: re-home any hash-bucket-stranded child of THIS project BEFORE the summary
  // read, so a stranded workspace is not silently undercounted. Scope the sweep to
  // the SAME project the store below opens (an explicit --worktree wins over cwd).
  try { rehomeStrandedProjectDescriptors(home, worktree ? Object.assign({}, ctx, { cwd: worktree }) : ctx); }
  catch (_) { /* fail-open: the list read proceeds regardless */ }
  const s = store.openStore({ home, workspaceId, hash: repoKey || undefined, backend: ctx.backend, env: ctx.env });
  let sum;
  // #62: a READ verb must not mutate — use the PURE computeSummary (zero summary.json
  // write) instead of deriveSummary (which surprised users by writing on a read).
  try { sum = store.computeSummary(s, { home, env: ctx.env, now: ctx.now }); }
  finally { s.close(); }
  const workspaces = Object.values(sum.workspaces || {});
  return { ok: true, action: 'workspaces', workspaceId: workspaceId || null, requiredGates: sum.requiredGates, count: workspaces.length, workspaces };
}

function cmdGate(id, flags, ctx) {
  const home = ctx.home;
  const setNames = csvList(flags, 'set');
  const clearNames = csvList(flags, 'clear');
  if (!setNames.length && !clearNames.length) {
    return { ok: false, error: 'gate needs --set <csv> and/or --clear <csv>' };
  }
  const setBy = one(flags, 'by') !== undefined ? one(flags, 'by') : 'devswarm-cli';
  // GH1: re-home a hash-bucket-stranded workspace into store/<repoKey>/ BEFORE
  // opening the store — otherwise the gate lands in / reads from the wrong store,
  // the workspace shows tracked:false, and the gate silently no-ops. Best-effort
  // + under the per-id lock (held internally); a no-op when not stranded.
  try { maybeRehomeToCwdProject(home, id, ctx); } catch (_) { /* fail-open: gate proceeds */ }
  // A1(c) fix: the SAME project-context-mismatch guard as cmdInboxMessages —
  // see its comment for the full rationale. An id whose descriptor names a
  // real, resolvable project that disagrees with (or is unreachable from)
  // this invocation's own cwd resolution must fail closed instead of
  // silently gating the legacy/wrong store and reporting tracked:false.
  const callerRepoKeyForGate = repoKeyForCwd(ctx);
  const descForGate = readDescriptorFile(home, id);
  const descRepoKeyForGate = descForGate ? descriptorFreshRepoKey(descForGate) : null;
  if (descRepoKeyForGate && descRepoKeyForGate !== callerRepoKeyForGate) {
    return {
      ok: false, id,
      reason: 'project-context-mismatch',
      error: 'workspace ' + JSON.stringify(id) + ' is registered under project ' + JSON.stringify(descRepoKeyForGate)
        + (callerRepoKeyForGate
          ? (', but the current context resolves to a DIFFERENT project ' + JSON.stringify(callerRepoKeyForGate))
          : ', but the current context could not resolve a project (non-git cwd?)')
        + ' — run this from within that project\'s worktree to gate it',
    };
  }
  // v0.57 mesh (D24): gates land in the SAME shared per-project store the
  // registry/roster/archive_ready read (repoKey, when resolvable).
  const s = store.openStore({ home, workspaceId: id, hash: callerRepoKeyForGate || undefined, backend: ctx.backend, env: ctx.env });
  let summary;
  try {
    for (const name of setNames) s.setGate({ workspaceId: id, name, value: true, setBy });
    for (const name of clearNames) s.setGate({ workspaceId: id, name, value: false, setBy });
    summary = store.deriveSummary(s, { home, env: ctx.env, now: ctx.now });
  } finally { s.close(); }
  const ws = (summary.workspaces || {})[id];
  // A5(c): an untracked id (no registry row in this project's summary — e.g. a
  // stray/typo'd/never-registered id) must NOT report ok:true — the set/clear
  // calls above landed in the store's gate table regardless, but with no
  // registry row for `id` nothing ever surfaces them (deriveSummary only
  // projects gates for rows it enumerates), so the caller's gate silently
  // no-ops. `tracked` already carried this signal; `ok` now agrees with it.
  return {
    ok: !!ws, action: 'gate', id, set: setNames, cleared: clearNames,
    gates: ws ? ws.gates : undefined,
    archive_ready: ws ? ws.archive_ready : undefined,
    tracked: !!ws,
  };
}

function cmdNudge(id, flags, ctx) {
  const home = ctx.home;
  const desc = readDescriptorFile(home, id);
  if (!desc) return { ok: false, error: 'no descriptor for workspace ' + JSON.stringify(id) };
  // Pass the persisted verdict (if any) so pokeOrEscalate honors attempt count +
  // cooldown across CLI invocations, exactly as the supervisor sweep does.
  let verdict = {};
  try { verdict = JSON.parse(fs.readFileSync(livenessPathFor(id, home), 'utf8')) || {}; } catch (_) { verdict = {}; }
  const res = pokeOrEscalate(desc, verdict, { home, now: ctx.now });
  return { ok: true, action: 'nudge', id, result: res };
}

// archivedTombstoneIsOrphaned(home, archivedStat) -> bool
//   true  == archived/<id>.json is a leftover from a PRIOR archive generation and
//            is safe to unlink+relink (NO live descriptor shares its inode).
//   false == its inode is shared with a LIVE descriptor under workspaces/ -> NEVER
//            unlink it (that would destroy a genuine active descriptor).
//
// WHY AN INODE TEST AND NOT "the registry has no live row for this id": that
// predicate is self-defeating here. cmdArchive only reaches the conflicting-link
// branch when the id's ACTIVE descriptor exists, i.e. the id IS live at that
// moment — a "no live row for this id" test can therefore never fire, and the
// stale tombstone would stay wedged forever. The question that actually matters is
// not "is this id live" but "is this FILE still somebody's active descriptor", and
// only (dev, ino) answers that: archived/<id>.json is created exclusively as a
// hardlink of a workspaces/<id>.json, so if no live descriptor shares its inode it
// can only be a dangling remnant of an archive generation that has already ended.
// Do not re-propose the registry-row predicate.
//
// FAIL CLOSED — the single most important property here. An unreadable/absent
// workspaces dir, or ANY lstat that leaves the scan incomplete, returns FALSE
// ("not orphaned"), so the caller keeps failing and nothing is unlinked. "I could
// not see any live descriptor" must NEVER be read as "nothing is live, safe to
// delete". A vanished entry (ENOENT between readdir and lstat) counts as an
// incomplete scan too: it may be a descriptor a concurrent archive just unlinked,
// in which case this archived path could be the last remaining link to it.
function archivedTombstoneIsOrphaned(home, archivedStat) {
  if (!archivedStat) return false;
  const dir = workspacesDir(home);
  let names;
  try { names = fs.readdirSync(dir); }
  catch (_) { return false; } // FAIL CLOSED
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let st;
    try { st = fs.lstatSync(path.join(dir, n)); }
    catch (_) { return false; } // FAIL CLOSED — incomplete scan
    if (st.dev === archivedStat.dev && st.ino === archivedStat.ino) return false;
  }
  return true;
}

// cmdArchive(id, ctx, opts) — archive a workspace descriptor + tombstone its
// registry row. The WHOLE descriptor+registry mutation runs under the per-id lock
// (P1-4) so a concurrent register/reap for the same id can never interleave.
// opts.revalidate(desc) (P1-5): an optional predicate run INSIDE the critical
// section, immediately before any mutation — return a truthy reason to SKIP the
// archive (used by the reaper to bail out on a workspace that went live between
// candidate collection and the archive call). All-or-nothing (P1-3): the active
// descriptor hardlink is RETAINED until the registry tombstone is durable, then
// the active descriptor is unlinked LAST; any mid-sequence failure ROLLS BACK.
function cmdArchive(id, ctx, opts) {
  const home = ctx.home;
  const revalidate = opts && typeof opts.revalidate === 'function' ? opts.revalidate : null;
  return withIdLock(id, home, () => {
  const activePath = descriptorPath(home, id);
  const archiveDirState = checkedArchivedDir(home, { create: true });
  if (!archiveDirState.ok) {
    return { ok: false, action: 'archive', id, descriptorArchived: false, error: 'unsafe archived directory: ' + archiveDirState.error };
  }
  const archivedPath = path.join(archiveDirState.path, id + '.json');
  const activeState = readDescriptorPathState(activePath);
  if (activeState.error) {
    return {
      ok: false, action: 'archive', id, descriptorArchived: false,
      error: 'failed to read existing descriptor: ' + activeState.error,
    };
  }
  let desc = activeState.descriptor;
  if (!activeState.exists) {
    const archivedState = readDescriptorPathState(archivedPath);
    if (archivedState.error) {
      return {
        ok: false, action: 'archive', id, descriptorArchived: false,
        error: 'failed to read archived descriptor: ' + archivedState.error,
      };
    }
    desc = archivedState.descriptor;
  }
  const currentRepoKey = repoKeyForCwd(ctx);
  const currentOwnerKey = currentRepoKey || store.hashFromWorkspaceId(id);
  let ownerKey = currentOwnerKey;
  if (desc) {
    if (!isSafeId(desc.id) || String(desc.id) !== String(id) || !desc.worktreePath) {
      return { ok: false, action: 'archive', id, descriptorArchived: false, error: 'descriptor identity does not match workspace ' + JSON.stringify(id) };
    }
    // G3 RE-HOME (archive path, P1-1/P1-2): a descriptor stranded in the legacy
    // hash bucket (persisted ownerKey === hashFromWorkspaceId(id)) whose project
    // now resolves must be HEALED before archiving — otherwise the ownership
    // check below rejects the workspace from its OWN project, and even if it
    // passed the tombstone would land in the hash bucket while the live row
    // (already re-homed by a prior read/send) sits in store/<repoKey>/, silently
    // leaving it un-archived. Mirrors the ensure branch's re-home. Only the hash-
    // bucket marker heals; a REAL differing repoKey (genuine cross-project) is
    // NOT === hashKey, so it falls through to the reject below (P1-6 extended to
    // archive). Lock already held (cmdArchive runs inside withIdLock).
    if (activeState.exists) {
      const storedOwnerKeyPre = typeof desc.ownerKey === 'string' && desc.ownerKey ? desc.ownerKey : null;
      const hashKey = store.hashFromWorkspaceId(id);
      if (currentRepoKey && storedOwnerKeyPre === hashKey && hashKey !== currentRepoKey) {
        const rh = rehomeCore(home, id, currentRepoKey, ctx);
        if (rh && rh.rehomed) {
          const reread = readDescriptorFile(home, id);
          if (reread && String(reread.id) === String(id)) desc = reread;
        }
      }
    }
    const storedOwnerKey = typeof desc.ownerKey === 'string' && desc.ownerKey ? desc.ownerKey : null;
    const structuralRepoKey = descriptorStructuralRepoKey(desc);
    const freshRepoKey = descriptorFreshRepoKey(desc);
    const activeLegacyPerId = activeState.exists && !storedOwnerKey && !structuralRepoKey && currentRepoKey === null;
    ownerKey = storedOwnerKey || structuralRepoKey || (activeLegacyPerId ? currentOwnerKey : null);
    if (!ownerKey || ownerKey !== currentOwnerKey) {
      return {
        ok: false, action: 'archive', id, descriptorArchived: false,
        error: 'descriptor does not belong to the current project',
      };
    }
    if (activeState.exists && !storedOwnerKey) {
      desc.ownerKey = currentOwnerKey;
      ownerKey = currentOwnerKey;
      if (currentRepoKey && freshRepoKey === currentRepoKey) desc.repoKey = currentRepoKey;
      try { writeDescriptorAtomic(home, id, desc); }
      catch (e) {
        return {
          ok: false, action: 'archive', id, descriptorArchived: false,
          error: 'failed to persist descriptor project identity: ' + String(e && e.message || e),
        };
      }
    }
  }
  // P1-5 TOCTOU re-validation: re-check the safety condition INSIDE the critical
  // section, immediately before any mutation. A heartbeat/activity that arrived
  // after the caller collected this as a candidate makes the workspace live again
  // -> SKIP (never archive a now-live workspace). No-op when no predicate given.
  if (revalidate) {
    let skipReason = null;
    try { skipReason = revalidate(desc); } catch (_) { skipReason = null; }
    if (skipReason) {
      return { ok: true, action: 'archive', id, descriptorArchived: false, skipped: true, reason: String(skipReason) };
    }
  }
  // P1-3 ALL-OR-NOTHING: link the descriptor into archived/ (keeping the ACTIVE
  // descriptor in place), tombstone the registry, and ONLY THEN unlink the active
  // descriptor. A failure at any step ROLLS BACK so archive is never half-applied
  // (the ENOSPC hazard: unlink-then-tombstone left descriptor archived + registry
  // live = split-brain).
  let linked = false; // archived hardlink created, active still present
  let moved = false;  // active descriptor unlinked -> fully archived
  if (activeState.exists) {
    try {
      try { fs.linkSync(activePath, archivedPath); }
      catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;
      }
      let activeStat = fs.lstatSync(activePath);
      let archivedStat = fs.lstatSync(archivedPath);
      if (activeStat.dev !== archivedStat.dev || activeStat.ino !== archivedStat.ino) {
        // SELF-HEAL a genuinely ORPHANED tombstone. The EEXIST swallowed above can
        // be a leftover archived/<id>.json from a PRIOR archive generation of this
        // same id (re-registered, then archived again) — with the old link still in
        // place the inode check fails and re-archiving the id is wedged FOREVER.
        // Unlink+relink is allowed ONLY when no live descriptor shares that inode
        // (see archivedTombstoneIsOrphaned, which fails CLOSED); otherwise the file
        // is a hardlink of somebody's genuine ACTIVE descriptor and we keep failing
        // — the never-clobber contract. activePath is never touched on any path.
        if (!archivedTombstoneIsOrphaned(home, archivedStat)) {
          throw new Error('archived descriptor already exists and is not the active descriptor');
        }
        // Replace the orphaned tombstone via link-to-temp + atomic rename, NOT
        // unlink-then-link. unlink-then-link is two independent syscalls with no
        // rollback between them: if linkSync throws (ENOSPC, EPERM) or the process
        // dies in the gap, archivedPath is left MISSING and the tombstone's bytes
        // are gone with nothing to replace them. A same-directory fs.renameSync is
        // atomic on POSIX and REPLACES an existing destination in one step, so
        // archivedPath is never observably missing at any instant. Do not
        // "simplify" this back to unlink+link.
        const healTmp = archivedPath + '.tmp-heal';
        try { fs.unlinkSync(healTmp); } catch (_) {} // clear a leftover from a prior crashed heal
        fs.linkSync(activePath, healTmp);
        try {
          fs.renameSync(healTmp, archivedPath); // atomic same-dir replace: archivedPath is never missing
        } catch (e) {
          try { fs.unlinkSync(healTmp); } catch (_) {} // never leave the temp link behind
          throw e;
        }
        // RE-VERIFY from disk (never trust the retry blind): only a fresh stat of
        // BOTH paths agreeing on (dev, ino) may set `linked`.
        activeStat = fs.lstatSync(activePath);
        archivedStat = fs.lstatSync(archivedPath);
        if (activeStat.dev !== archivedStat.dev || activeStat.ino !== archivedStat.ino) {
          throw new Error('archived descriptor already exists and is not the active descriptor');
        }
      }
      linked = true;
    } catch (e) {
      return {
        ok: false, action: 'archive', id, descriptorArchived: false,
        error: 'failed to link descriptor into archived/: ' + String(e && e.message || e),
      };
    }
  }
  // G2 crash-safe: persist a recovery-intent marker BEFORE tombstoning. If the
  // in-process rollback below ALSO fails (ENOSPC defeats the revive upsert) OR the
  // process is killed mid-sequence, this durable marker lets doctor/next-run
  // revive the registry row — closing the split-brain window (active descriptor +
  // tombstoned registry) that swallowing a revive failure would otherwise leave.
  // Only meaningful when we have a descriptor to revive from.
  if (desc) {
    try { writeRecoveryIntent(home, id, { id, ownerKey, op: 'archive', descriptor: desc, fingerprint: descriptorFingerprint(desc), ts: Date.now() }); }
    catch (e) {
      // Cannot even record the intent — do NOT tombstone (we would have no
      // crash-safe record). Roll back the link and abort; nothing was archived.
      if (linked && activeState.exists) { try { fs.unlinkSync(archivedPath); } catch (_) {} }
      return {
        ok: false, action: 'archive', id, descriptorArchived: false,
        error: 'failed to persist archive recovery-intent (nothing archived): ' + String(e && e.message || e),
      };
    }
  }
  // v0.57 mesh (D24): tombstone the registry entry in the SAME shared per-project
  // store `register`/`roster` populate (repoKey, when resolvable). Done BEFORE the
  // active unlink so an ENOSPC/IO failure here leaves BOTH the descriptor and the
  // registry row intact.
  //
  // WHOLE-GROUP RETIRE (archived-still-active fix): tombstoning THIS id alone
  // left every OTHER registry row for the SAME physical worktree live, and a
  // live row IS what computeSummary projects as an active workspace — so the
  // workspace the user just archived kept showing up as active under a
  // duplicate row (see retireArchivedWorktreeGroup for the full mechanism).
  // Runs BEFORE this id's own tombstone, and forward-before-tombstone, so the
  // duplicates' unread backlog lands in THIS id's partition rather than being
  // scattered across partitions nothing will ever drain. It is fail-open (never
  // throws), so the only thing that can throw inside this try — and therefore
  // the only thing that can trigger the rollback below — is still the tombstone
  // itself, exactly as before: the all-or-nothing discipline for the archived
  // descriptor+row pair is unchanged. If the rollback does fire, the forwarded
  // rows are already durable in this id's partition and its registry row is
  // revived, so nothing is stranded and a retry is idempotent.
  let groupRetire = null;
  try {
    const s = store.openStore({ home, workspaceId: id, hash: ownerKey, backend: ctx.backend, env: ctx.env });
    try {
      groupRetire = retireArchivedWorktreeGroup(s, home, id, desc && desc.worktreePath);
      s.removeRegistry(id);
      store.deriveSummary(s, { home, env: ctx.env });
    }
    finally { s.close(); }
  } catch (e) {
    // ROLLBACK. The failure may have hit AFTER removeRegistry appended its
    // tombstone (e.g. the subsequent deriveSummary write failed on ENOSPC), so
    // REVIVE the registry row (upsert wins as the newest op — a no-op if the
    // tombstone never landed) and drop the archived hardlink. Net result: the
    // active descriptor + a live registry row remain, exactly as before the call.
    let revived = false;
    if (desc) {
      try {
        const s2 = store.openStore({ home, workspaceId: id, hash: ownerKey, backend: ctx.backend, env: ctx.env });
        try { s2.upsertRegistry(desc); }
        finally { s2.close(); }
        // VERIFY the row is live again (pure fold read; deriveSummary intentionally
        // skipped — it is what failed). A verified restore is the ONLY thing that
        // clears the recovery-intent.
        revived = registryRowPresent(home, id, ownerKey, ctx);
      } catch (_) { revived = false; }
    }
    if (linked && activeState.exists) { try { fs.unlinkSync(archivedPath); } catch (_) {} }
    if (desc && !revived) {
      // Revive ALSO failed — do NOT swallow. Leave the recovery-intent in place so
      // doctor/next-run restores the row; report a HARD error (split-brain averted
      // only by the durable marker, not by an in-process rollback).
      return {
        ok: false, action: 'archive', id, descriptorArchived: false, recoveryIntent: true,
        error: 'failed to tombstone registry AND failed to revive it — recovery-intent persisted for repair: ' + String(e && e.message || e),
      };
    }
    clearRecoveryIntent(home, id);
    return {
      ok: false, action: 'archive', id, descriptorArchived: false,
      error: 'failed to tombstone registry (rolled back — nothing archived): ' + String(e && e.message || e),
    };
  }
  // Registry tombstone is durable — unlink the active descriptor LAST.
  if (activeState.exists) {
    try { fs.unlinkSync(activePath); moved = true; }
    catch (e) {
      // The active unlink failed AFTER a durable tombstone. REVIVE the registry row
      // (upsert wins as the newest op) and drop the archived link so we restore the
      // pre-archive all-or-nothing state instead of stranding a registry-less live
      // descriptor. Report failure; the caller can retry.
      let revived = false;
      if (desc) {
        try {
          const s2 = store.openStore({ home, workspaceId: id, hash: ownerKey, backend: ctx.backend, env: ctx.env });
          try { s2.upsertRegistry(desc); store.deriveSummary(s2, { home, env: ctx.env }); }
          finally { s2.close(); }
          revived = registryRowPresent(home, id, ownerKey, ctx);
        } catch (_) { revived = false; }
      }
      if (linked) { try { fs.unlinkSync(archivedPath); } catch (_) {} }
      if (desc && !revived) {
        // Revive ALSO failed — leave the recovery-intent for doctor/next-run.
        return {
          ok: false, action: 'archive', id, descriptorArchived: false, recoveryIntent: true,
          error: 'failed to remove active descriptor after tombstone AND failed to revive registry — recovery-intent persisted for repair: ' + String(e && e.message || e),
        };
      }
      clearRecoveryIntent(home, id);
      return {
        ok: false, action: 'archive', id, descriptorArchived: false,
        error: 'failed to remove active descriptor after tombstone (registry revived — nothing archived): ' + String(e && e.message || e),
      };
    }
  }
  // Archive fully completed — the recovery-intent is discharged.
  clearRecoveryIntent(home, id);
  const archived = {
    ok: true, action: 'archive', id, descriptorArchived: moved,
    manualStep: 'hivecontrol has no teardown command — REMOVE workspace ' + id +
      ' in the DevSwarm app (archive keeps disk contents; never delete without confirmation).',
  };
  // Surface the whole-group retire ONLY when it did something — a plain archive
  // of a single-row worktree keeps its existing return shape byte-for-byte.
  // `leftDuplicates` is the honest half: a same-worktree row the safety gate
  // refused to tombstone is REPORTED with its reason, never silently dropped.
  if (groupRetire) {
    if (groupRetire.retired.length) archived.retiredDuplicates = groupRetire.retired;
    if (groupRetire.forwarded) archived.forwardedFromDuplicates = groupRetire.forwarded;
    if (groupRetire.left.length) archived.leftDuplicates = groupRetire.left;
  }
  return archived;
  });
}

// cmdUnarchive(id, ctx) — reverse of cmdArchive: link the descriptor back into
// workspaces/, remove the archived recovery anchor, then re-upsert the store
// registry (append-only:
// a fresh upsertRegistry after a prior removeRegistry simply wins as the
// newest op for this id, reviving the tombstoned row — same latest-op-wins
// mechanics cmdArchive itself relies on). Non-destructive, id-safe (the
// dispatcher gates `id` through isSafeId before this is ever called, same as
// `archive`). For undoing a wrong `archive`.
function cmdUnarchive(id, ctx) {
  const home = ctx.home;
  // P1-4: unarchive mutates the same descriptor+registry pair as register/archive
  // — run it under the SAME per-id lock so the three can never interleave.
  return withIdLock(id, home, () => {
  const archiveDirState = checkedArchivedDir(home);
  if (!archiveDirState.ok) {
    return { ok: false, action: 'unarchive', id, error: 'unsafe archived directory: ' + archiveDirState.error };
  }
  const archivedPath = path.join(archiveDirState.path, id + '.json');
  const activePath = descriptorPath(home, id);
  const archivedState = readDescriptorPathState(archivedPath);
  if (archivedState.error) {
    return { ok: false, action: 'unarchive', id, error: 'failed to read archived descriptor: ' + archivedState.error };
  }
  const activeState = archivedState.exists ? null : readDescriptorPathState(activePath);
  if (activeState && activeState.error) {
    return { ok: false, action: 'unarchive', id, error: 'failed to read restored descriptor: ' + activeState.error };
  }
  if (!archivedState.exists && (!activeState || !activeState.exists)) {
    return { ok: false, action: 'unarchive', id, error: 'no archived descriptor for workspace ' + JSON.stringify(id) };
  }
  const desc = archivedState.exists ? archivedState.descriptor : activeState.descriptor;
  if (!isSafeId(desc.id) || String(desc.id) !== String(id) || !desc.worktreePath) {
    return { ok: false, action: 'unarchive', id, error: 'archived descriptor identity does not match workspace ' + JSON.stringify(id) };
  }
  const currentOwnerKey = storeOwnerKeyFor(id, ctx);
  const ownerKey = descriptorPhysicalOwnerKey(desc);
  if (!ownerKey || ownerKey !== currentOwnerKey) {
    return { ok: false, action: 'unarchive', id, error: 'archived descriptor does not belong to the current project' };
  }
  if (archivedState.exists) {
    try {
      fs.mkdirSync(workspacesDir(home), { recursive: true });
      try { fs.linkSync(archivedPath, activePath); }
      catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;
      }
      const archivedStat = fs.lstatSync(archivedPath);
      const activeStat = fs.lstatSync(activePath);
      if (archivedStat.dev !== activeStat.dev || archivedStat.ino !== activeStat.ino) {
        return { ok: false, action: 'unarchive', id, error: 'active descriptor already exists and is not the archived recovery anchor' };
      }
      try { fs.unlinkSync(archivedPath); }
      catch (e) {
        try { fs.unlinkSync(activePath); } catch (_) {}
        return { ok: false, action: 'unarchive', id, error: 'failed to move descriptor out of archived/: ' + String(e && e.message || e) };
      }
    } catch (e) {
      return {
        ok: false, action: 'unarchive', id,
        error: 'failed to prepare descriptor restore: ' + String(e && e.message || e),
      };
    }
  }
  if (desc.ownerKey !== ownerKey) {
    desc.ownerKey = ownerKey;
    try { writeDescriptorAtomic(home, id, desc); }
    catch (e) {
      return { ok: false, action: 'unarchive', id, error: 'failed to persist descriptor store ownership: ' + String(e && e.message || e) };
    }
  }
  try {
    const s = store.openStore({ home, workspaceId: desc.id, hash: ownerKey, backend: ctx.backend, env: ctx.env });
    try {
      s.upsertRegistry(desc);
      store.deriveSummary(s, { home, env: ctx.env });
    } finally { s.close(); }
  }
  catch (e) {
    return { ok: false, action: 'unarchive', id, error: 'failed to revive registry: ' + String(e && e.message || e) };
  }
  return { ok: true, action: 'unarchive', id, descriptorRestored: true };
  });
}

function cmdArchiveIgnore(id, ctx, { set }) {
  const home = ctx.home;
  const dir = archiveIgnoreDir(home);
  const p = path.join(dir, id + '.json');
  if (set) {
    fs.mkdirSync(dir, { recursive: true });
    const mark = { id, ignoredAt: Number.isFinite(ctx.now) ? ctx.now : Date.now() };
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mark));
    fs.renameSync(tmp, p);
    return { ok: true, action: 'archive-ignore', id, ignored: true };
  }
  let removed = false;
  try { fs.unlinkSync(p); removed = true; } catch (_) { removed = false; }
  return { ok: true, action: 'archive-unignore', id, removed };
}

// skipFilePath(home) — computed identically to hooks/skip-guard.js's own
// SKIP_FILE constant (path.join(os.homedir(), '.anti-hall', 'skip.json')),
// just home-injectable like every other path helper above (workspacesDir,
// archiveIgnoreDir, ...) so tests can point it at a tmp HOME instead of the
// real machine. With ctx.home defaulting to os.homedir() (see run()), the
// production path is byte-identical to skip-guard.js's.
function skipFilePath(home) { return path.join(home, '.anti-hall', 'skip.json'); }

// cmdSkip(guard, flags, ctx) — the documented escape hatch for anti-hall's own
// guards (see hooks/skip-guard.js): writes/merges { [guard]: expiryUnixMs }
// into skip.json so every guard's own isSkipped(name) check fail-opens while
// unexpired. This is the CLI-side half of edit-guard's own block-message hint
// ("run 'node scripts/devswarm.js skip edit-guard'") — previously the message
// pointed agents at a mechanism with no CLI entry point.
function cmdSkip(guard, flags, ctx) {
  const home = ctx.home;
  // A bare `--ttl` (no following value, e.g. end-of-argv or immediately
  // followed by another `--flag`) parses to boolean `true` in parseArgs(),
  // which one() maps to `undefined` — indistinguishable from "--ttl not
  // passed at all". Check the raw flags bucket first so a bare `--ttl`
  // errors instead of silently falling through to the 15-minute default.
  const ttlFlagPassed = Array.isArray(flags.ttl) && flags.ttl.length > 0;
  const rawTtl = one(flags, 'ttl');
  let ttlMinutes = 15;
  if (ttlFlagPassed && rawTtl === undefined) {
    return { ok: false, error: 'invalid --ttl (missing value; expected a positive number of minutes)' };
  }
  if (rawTtl !== undefined) {
    const n = Number(rawTtl);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: 'invalid --ttl (must be a positive number of minutes)' };
    }
    ttlMinutes = n;
  }
  const dir = path.join(home, '.anti-hall');
  const file = skipFilePath(home);
  let data = {};
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      // Require a plain non-array object: JSON.stringify on an array only
      // serializes index/length properties, so `data[guard] = expiresAt`
      // on an array would be silently dropped on write (reported ok:true
      // with nothing actually persisted). Reset to {} instead of accepting
      // array-shaped skip.json.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    }
  } catch (_) {
    data = {}; // missing / unreadable / bad JSON -> start fresh, never blocks the write
  }
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const expiresAt = now + ttlMinutes * 60000;
  // Guard BEFORE writing anything: an astronomically large but finite --ttl
  // can overflow `now + ttlMinutes*60000` to Infinity. JSON.stringify(Infinity)
  // serializes as `null`, which the guard's `data[name] > now` check reads as
  // false -- reporting success while silently never actually skipping. Worse,
  // computing expiresAtIso via `new Date(Infinity).toISOString()` throws
  // AFTER the file would already be written, corrupting skip.json with a
  // `null` entry under an ok:false response. Reject up front instead.
  if (!Number.isFinite(expiresAt)) {
    return { ok: false, error: 'invalid --ttl (resulting expiry is not a finite value)' };
  }
  data[guard] = expiresAt;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return {
    ok: true, action: 'skip', guard, ttlMinutes,
    expiresAt, expiresAtIso: new Date(expiresAt).toISOString(), path: file,
  };
}

// buildArchiveRequestMessage(reason) — the exact posted string. `reason` is
// optional; when omitted the marker + instruction still stand alone.
function buildArchiveRequestMessage(reason) {
  const tail = 'your parent asks you to archive this workspace; confirm with your user, then run devswarm.js archive <id>.';
  return reason
    ? store.ARCHIVE_REQUEST_MARKER + ' ' + reason + ' — ' + tail
    : store.ARCHIVE_REQUEST_MARKER + ' — ' + tail;
}

// cmdArchiveRequest(id, flags, ctx) — v0.58 (PLAN.md CLI VERB CONTRACT): STORE
// WRITE, never a native hivecontrol call. Posts a parent->child `[[ANTIHALL_
// ARCHIVE_REQUEST]]` mesh-direct message straight into `id`'s OWN store
// partition — `id` is ALREADY the target's real read partition (its registered
// builder-id/workspaceId, the SAME semantics `heartbeat <id>` and `inbox read
// <id>` already use), so, unlike `send --to <meshId>`, no registry/meshId
// resolution is needed or performed. `urgency:'high'` (a mechanical, fixed
// choice — never 'urgent', which stays reserved for a sender's own judgment
// call elsewhere). AGNOSTIC: this verb never itself verifies merged/tested/
// deployed — that stays the RECEIVING parent's own repo policy; the message
// only reminds, never gates. DELETES the OLD native `list children` lookup +
// `message-child` spawn (pre-v0.58: resolveChildBranch + ctx.io.run) — the
// marker now travels over the SAME daemon-independent mesh path every other
// send uses, closing the one native-messaging leak the command-guard could
// never catch (a spawned `message-child` call is invisible to a guard that
// only inspects the FIRST hivecontrol subcommand token by design).
function cmdArchiveRequest(id, flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };

  const reason = one(flags, 'reason');
  const message = buildArchiveRequestMessage(reason);
  const from = callerIdentity(ctx.env, cwd);
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();

  // A3 (partial fix, v0.66 review): serialize against a concurrent rehome/
  // retire of THIS SAME id — the SAME per-id lock cmdSend's orphan-race fix
  // uses — so a rehomeAcrossStores that migrates id's registry row + backlog
  // to ANOTHER project's store cannot interleave between this call's store
  // resolution and its append (the "rehoming" leg of the reported defect;
  // once inside the lock, no concurrent mutator of this id can run, since
  // every mutator — register/archive/rehome — takes the identical lock).
  //
  // Deliberately UNCHANGED for a childId that carries NO registry row in this
  // store at all: unlike `send --to <meshId>`, archive-request has never
  // required registry membership — `id` IS its own read partition by design
  // (the SAME semantics `heartbeat <id>`/`inbox read <id>` already use; see
  // this function's own header comment) — and this is an explicitly TESTED
  // contract ("archive-request makes ZERO hivecontrol calls" /
  // devswarm-cli.test.js posts to an id that was never registered and expects
  // ok:true). A genuinely typo'd or already-retired childId is therefore
  // STILL NOT detectable here: both states are represented identically as
  // "no registry row", and retiring a row (foldGroupIntoSurvivor) tombstones
  // it outright with no redirect record to consult — see openConcerns.
  return withIdLock(String(id), home, () => {
    const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
    try {
      const fields = { from, to: id, type: 'direct', message, timestamp: now, urgency: 'high' };
      const hash = store.meshMessageHash(fields);
      const res = store.appendMeshMessage(s, Object.assign({}, fields, { hash }));
      store.deriveSummary(s, { home, env: ctx.env, now });
      return {
        ok: true, action: 'archive-request', id, childId: id, posted: true,
        sent: !!res.inserted, seq: res.seq, reason: reason || null,
        reminder: 'Ensure you have verified merged + tested + deployed per your repo policy before archiving.',
      };
    } finally { s.close(); }
  });
}

function cmdMigrate(ctx) {
  return migrate.migrateToStore({ home: ctx.home, backend: ctx.backend, env: ctx.env, now: ctx.now });
}

// migrateOwnerKeys(home, ctx0) — P1-8 forward-migration for the `ownerKey`
// descriptor field (per the persisted-shape-migration mandate). IDEMPOTENT,
// FAIL-OPEN, NO-DELETE, safe to run repeatedly; shipped in BOTH the update path
// AND doctor. For every descriptor (ACTIVE and ARCHIVED):
//   - backfills a MISSING ownerKey using the SAME resolution `register` uses
//     (worktree-derived repoKey if resolvable, else structural repoKey, else the
//     id-derived hash bucket key), and
//   - HEALS prior hash-bucket split-brain: an ACTIVE descriptor whose ownerKey is
//     the legacy hash bucket while its worktree now resolves a real repoKey is
//     re-homed via rehomeCore (registry row + messages migrated, ownerKey
//     rewritten). ARCHIVED descriptors are only field-backfilled — never
//     re-homed, because their registry row is already tombstoned and reviving it
//     would silently un-archive the workspace.
// Each descriptor is processed under its own per-id lock. Never throws.
function migrateOwnerKeys(home, ctx0) {
  const ctx = Object.assign({ home, env: process.env }, ctx0 || {});
  const dryRun = !!(ctx0 && ctx0.dryRun);
  const out = { ok: true, action: 'migrate-owner-keys', dryRun, scanned: 0, backfilled: 0, rehomed: 0, errors: 0 };
  const seen = new Set();
  const writeAt = (p, desc) => {
    const tmp = p + '.' + process.pid + '.' + (heartbeatTmpCounter++) + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(desc)); fs.renameSync(tmp, p); }
    catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} throw e; }
  };
  const consider = (rawDesc, isArchived, archivedPath) => {
    if (!rawDesc || !isSafeId(rawDesc.id) || !rawDesc.worktreePath) return;
    if (seen.has(rawDesc.id)) return;
    seen.add(rawDesc.id);
    out.scanned++;
    try {
      withIdLock(rawDesc.id, home, () => {
        // Re-read under the lock so we never overwrite a concurrent live mutation.
        let live = isArchived ? null : readDescriptorFile(home, rawDesc.id);
        let target = descriptorPath(home, rawDesc.id);
        if (!live && isArchived) {
          const st = readDescriptorPathState(archivedPath);
          if (st.descriptor) { live = st.descriptor; target = archivedPath; }
        }
        if (!live) return;
        const hashKey = store.hashFromWorkspaceId(live.id);
        const freshRepoKey = descriptorFreshRepoKey(live);
        const storedOwnerKey = typeof live.ownerKey === 'string' && live.ownerKey ? live.ownerKey : null;
        // Heal ACTIVE hash-bucket split-brain (never archived — see header).
        if (!isArchived && storedOwnerKey === hashKey && freshRepoKey && freshRepoKey !== hashKey) {
          if (dryRun) { out.rehomed++; return; } // detect-only: count the candidate
          const rh = rehomeCore(home, live.id, freshRepoKey, ctx);
          if (rh && rh.rehomed) { out.rehomed++; return; } // rehomeCore already rewrote ownerKey
          return;
        }
        // Backfill a MISSING ownerKey (both active + archived).
        if (!storedOwnerKey) {
          if (dryRun) { out.backfilled++; return; } // detect-only: count the candidate
          const resolved = freshRepoKey || descriptorStructuralRepoKey(live) || hashKey;
          live.ownerKey = resolved;
          if (freshRepoKey && freshRepoKey === resolved) live.repoKey = freshRepoKey;
          writeAt(target, live);
          out.backfilled++;
        }
      });
    } catch (_) { out.errors++; }
  };
  // GH2: enumerate ACTIVE descriptors via a RAW workspacesDir listing (same
  // pattern as the archived branch below) — NOT readDescriptors, which filters on
  // sessionId/worktreePath and so SKIPS the very legacy descriptors (no sessionId)
  // this migration exists to backfill/re-home.
  try {
    const wd = workspacesDir(home);
    let names = [];
    try { names = fs.readdirSync(wd); } catch (_) { names = []; }
    for (const n of names) {
      if (!/\.json$/.test(n)) continue;
      const st = readDescriptorPathState(path.join(wd, n));
      if (st.descriptor) consider(st.descriptor, false, null);
    }
  } catch (_) {}
  try {
    const ad = checkedArchivedDir(home);
    if (ad.ok && ad.exists) {
      let names = [];
      try { names = fs.readdirSync(ad.path); } catch (_) { names = []; }
      for (const n of names) {
        if (!/\.json$/.test(n)) continue;
        const ap = path.join(ad.path, n);
        const st = readDescriptorPathState(ap);
        if (st.descriptor) consider(st.descriptor, true, ap);
      }
    }
  } catch (_) {}
  // A5(b): errors were counted but never reflected in `ok` — a caller checking
  // top-level ok saw success even when every single descriptor failed to
  // migrate. `out.ok` was seeded true at construction; correct it here.
  out.ok = out.errors === 0;
  return out;
}

// applyRecoveryIntents(home, ctx0) — G2 doctor/next-run companion for cmdArchive's
// crash-safe recovery-intent markers. A marker lingers only when a prior archive
// tombstoned the registry row but its in-process rollback/clear did NOT complete
// (revive also failed, or the process was killed mid-sequence). For each marker,
// under the per-id lock, restore consistency:
//   - active descriptor STILL present  -> the archive never finished the destructive
//     unlink; re-upsert the registry row so active+registry are consistent again.
//   - active descriptor already GONE    -> the destructive step completed; the
//     consistent end-state is registry-tombstoned. Do NOT un-archive; just clear the
//     stale marker (mirrors migrateOwnerKeys' archived-descriptor no-revive rule).
// IDEMPOTENT, FAIL-OPEN, NO-DELETE. dryRun counts pending markers without touching.
function applyRecoveryIntents(home, ctx0) {
  const ctx = Object.assign({ home, env: process.env }, ctx0 || {});
  const dryRun = !!(ctx0 && ctx0.dryRun);
  const out = { ok: true, action: 'recover-archive-intent', dryRun, pending: 0, revived: 0, cleared: 0, errors: 0 };
  const dir = recoveryIntentDir(home);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    const id = n.slice(0, -5);
    if (!isSafeId(id)) continue;
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { marker = null; }
    const usable = marker && marker.descriptor && typeof marker.descriptor === 'object'
      && typeof marker.ownerKey === 'string' && marker.ownerKey
      && String(marker.id) === String(id);
    if (!usable) {
      // An unreadable/malformed marker carries nothing to revive from — clear it.
      if (!dryRun) { clearRecoveryIntent(home, id); out.cleared++; }
      continue;
    }
    out.pending++;
    if (dryRun) continue;
    withIdLock(id, home, () => {
      const active = readDescriptorFile(home, id);
      if (!active) {
        // Archive completed the destructive unlink — do NOT resurrect it.
        clearRecoveryIntent(home, id);
        out.cleared++;
        return;
      }
      // P1 fix: a marker with no identity check would revive `marker.descriptor`
      // blindly whenever ANY active descriptor exists at this id — including one
      // that was legitimately RE-REGISTERED with fresh content after a crashed
      // archive (ids are deterministic, so the same id can come back to life).
      // That clobbered the fresh registry row with the stale pre-archive one.
      // Only revive when the current active descriptor's fingerprint matches the
      // one captured at marker-write time (archive genuinely never finished).
      if (typeof marker.fingerprint === 'string' && marker.fingerprint) {
        const currentFp = descriptorFingerprint(active);
        if (currentFp !== marker.fingerprint) {
          // The id was re-registered since the marker was written — the newer
          // register already wrote a correct row. Marker is stale: clear, don't upsert.
          clearRecoveryIntent(home, id);
          out.cleared++;
          return;
        }
      } else {
        // Backward-compat: a marker written before the fingerprint field existed.
        // Unverifiable — only revive if the registry row is genuinely absent; if a
        // row already exists (fresh or otherwise), never blind-clobber it.
        if (registryRowPresent(home, id, marker.ownerKey, ctx)) {
          clearRecoveryIntent(home, id);
          out.cleared++;
          return;
        }
      }
      let revived = false;
      try {
        const s = store.openStore({ home, workspaceId: id, hash: marker.ownerKey, backend: ctx.backend, env: ctx.env });
        try { s.upsertRegistry(marker.descriptor); store.deriveSummary(s, { home, env: ctx.env }); }
        finally { s.close(); }
        revived = registryRowPresent(home, id, marker.ownerKey, ctx);
      } catch (_) { revived = false; }
      if (revived) { clearRecoveryIntent(home, id); out.revived++; }
      else out.errors++; // still failing (e.g. ENOSPC persists) — leave the marker
    });
  }
  // A5(b): same fix as migrateOwnerKeys — errors were counted but never
  // reflected in `ok`.
  out.ok = out.errors === 0;
  return out;
}

// rehomeStrandedProjectDescriptors(home, ctx) -> count re-homed. GH1 multi-id
// re-home pass for callers with NO single target id (cmdReconcile / cmdWorkspaces
// list): raw-scan the active workspaces dir and re-home EVERY descriptor that is
// (a) stranded in the legacy hash bucket (persisted ownerKey === hashFromWorkspaceId(id))
// AND (b) whose OWN worktree resolves to THIS invocation's project repoKey — so a
// hash-bucket-stranded child of this project becomes visible to the listRegistry/
// summary read that follows, instead of silently undercounting / never draining.
// Constraint (b) is what keeps this from dragging another project's descriptor into
// this cwd's store. Reuses rehomeCore under the per-id lock; fail-open per id.
function rehomeStrandedProjectDescriptors(home, ctx) {
  const repoKey = repoKeyForCwd(ctx);
  if (!repoKey) return 0;
  let names = [];
  try { names = fs.readdirSync(workspacesDir(home)); } catch (_) { return 0; }
  let rehomed = 0;
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    const id = n.slice(0, -5);
    if (!isSafeId(id)) continue;
    const desc = readDescriptorFile(home, id);
    if (!desc || String(desc.id) !== String(id) || !desc.worktreePath) continue;
    const storedOwnerKey = typeof desc.ownerKey === 'string' && desc.ownerKey ? desc.ownerKey : null;
    const hashKey = store.hashFromWorkspaceId(id);
    if (storedOwnerKey !== hashKey || hashKey === repoKey) continue; // not stranded
    let fresh = null;
    try { fresh = descriptorFreshRepoKey(desc); } catch (_) { fresh = null; }
    if (fresh !== repoKey) continue; // only heal descriptors whose worktree is THIS project
    try {
      const rh = withIdLock(id, home, () => rehomeCore(home, id, repoKey, ctx));
      if (rh && rh.rehomed) rehomed++;
    } catch (_) { /* fail-open: a re-home hiccup must never break the sweep */ }
  }
  return rehomed;
}

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

// resolveMeshTarget(storeHandle, meshId) -> the registry descriptor whose
// worktree-derived meshId matches `meshId`, or null (fail-closed, D12a).
//
// meshId is NEVER stored as a schema field (Blast-radius note, D19): it is
// recomputed on every lookup from each registry entry's `worktreePath` via the
// SAME hardened primitive `callerIdentity` uses for a resolved worktree
// (`inst.primaryWorkspaceId`) — so a sender and the address book derive a given
// worktree's meshId IDENTICALLY, and the address book can never be env-spoofed
// (it is derived from the REGISTERED worktree path, never from any caller's
// env). This is the D19 join: `--to <meshId>` resolves to the target's real
// read partition (`d.id`, the builder-id), NOT the meshId itself.
// meshCursorValue(storeHandle, id) -> the row's durable inbox cursor as a finite
// number, or -1 (unreadable/absent). A safe wrapper over the store's cursorValue
// primitive (both backends expose it) used ONLY as the updatedAt-tie drain signal
// in resolveMeshTarget — never throws (a cursor read must not break addressing).
function meshCursorValue(storeHandle, id) {
  try {
    const v = storeHandle.cursorValue(id);
    return Number.isFinite(v) ? v : -1;
  } catch (_) { return -1; }
}

function resolveMeshTarget(storeHandle, meshId) {
  if (!meshId) return null;
  // A single worktreePath can carry MORE THAN ONE registry row that ALL resolve to
  // the same meshId. Concretely observed: the `spawn` phantom (keyed BY the meshId,
  // `sessionId:null`, no live session draining it) AND the child's own self-
  // registration (keyed by its builder-id, a real `sessionId`); and — the P0 case
  // this fix closes — TWO *live* builder-id rows for one worktree (a child that re-
  // registered under a NEW builder-id while an older builder-id row is still live,
  // OR a same-worktree duplicate the retire reconcile deliberately LEFT rather than
  // risk mis-tombstoning a distinct child, P1). listRegistry orders by id-sort, so a
  // bare "first live by id-ASC" is an id-ordering ACCIDENT: it can hand the send to a
  // STRANDED row that no live session drains -> silent message loss (verified repro,
  // both backends).
  //
  // ROUTE TO THE PARTITION THE CHILD ACTUALLY DRAINS, independent of retire timing/
  // success. The deterministic, store-native, drain-correlated signal: among LIVE
  // rows (non-empty sessionId), the one with the GREATEST registry `updatedAt`. A
  // live child re-registers its OWN partition every turn (inbox pull auto-ensures),
  // so the drained row's updatedAt keeps advancing; a stale/stranded duplicate stops
  // advancing the moment its session dies. Freshest-live is therefore the row a live
  // session is currently maintaining = the one it drains. The phantom (sessionId
  // null) is excluded by the liveness filter outright. Ties (equal/absent updatedAt)
  // fall back to id-ASC order (first encountered), and when NO row is live yet we
  // fall back to the first match (only the phantom exists, pre-self-register) — so
  // this is a strict refinement of the prior "prefer live" behavior, never worse.
  let firstMatch = null;
  let bestLive = null;
  for (const d of storeHandle.listRegistry()) {
    if (!d || !d.worktreePath) continue;
    if (inst.primaryWorkspaceId(d.worktreePath) !== String(meshId)) continue;
    if (firstMatch === null) firstMatch = d; // first match (phantom) — fallback when nothing is live
    if (!isLiveSessionId(d.sessionId)) continue; // not live (A6: excludes the synthetic auto-ensure marker) -> never a drain target
    if (bestLive === null) { bestLive = d; continue; }
    const a = Number.isFinite(d.updatedAt) ? d.updatedAt : -1;
    const b = Number.isFinite(bestLive.updatedAt) ? bestLive.updatedAt : -1;
    if (a > b) { bestLive = d; continue; } // strictly fresher live row wins
    if (a === b) {
      // updatedAt TIE (same-ms register race, devswarm-store.js upsert): id-ASC order
      // is drain-AGNOSTIC and can hand the send to a stale row that merely sorts first
      // (e.g. `aaa-stale` over `zzz-draining`). Break the tie by a DRAIN-CORRELATED
      // signal instead — the row whose inbox cursor is higher has actually READ more
      // messages, so it is the one a live session is currently draining. Only fall back
      // to id-ASC-first (keep the current bestLive) if the cursors are also equal.
      if (meshCursorValue(storeHandle, d.id) > meshCursorValue(storeHandle, bestLive.id)) bestLive = d;
    }
  }
  return bestLive || firstMatch;
}

// resolveSendTarget(storeHandle, arg) -> { target, ambiguous, candidates }.
//
// `send --to <arg>` addressing footgun (P0 fix): resolveMeshTarget ONLY matches
// `arg` against each row's WORKTREE-DERIVED meshId — but `roster` (below)
// surfaced each row's own `id` (its REAL read partition, the value cmdSend
// actually delivers into) and never its meshId (only `diagnose` showed that).
// A human/agent that copies a roster `id` into `--to` therefore failed closed
// as `unregistered-recipient` even though the workspace IS registered.
//
// Fix: when the EXISTING meshId pass finds nothing, fall back to an EXACT
// match against each row's own `id` — the row IS the partition (`target.id`
// is exactly what cmdSend delivers into today), so an id match resolves
// directly to it with zero ambiguity about WHICH partition receives the
// message. `id` is the registry's PRIMARY KEY (devswarm-store.js: `id TEXT
// PRIMARY KEY`) — one row per id, enforced by the store itself — so this can
// never actually be ambiguous within a single store's listRegistry(); the
// ambiguity guard below is defense-in-depth only (a corrupted/duplicated
// registry read must fail loud with a clear reason, never silently pick one
// candidate over another).
//
// The pre-existing meshId path is computed FIRST and a caller already
// addressing by meshId with no distinct exact-id row sees identical behavior
// to before this fix. SHADOW GUARD (P0): an exact-id match is no longer
// returned unconditionally without checking the meshId pass — if BOTH resolve
// and they name DIFFERENT rows, that is a genuine collision (row A's real id
// equals row B's derived meshId) and must fail loud as ambiguous rather than
// silently preferring the meshId match and shadowing the exact-id row.
function resolveSendTarget(storeHandle, arg) {
  const byMesh = resolveMeshTarget(storeHandle, arg);
  if (!arg) return byMesh ? { target: byMesh, ambiguous: false, candidates: null } : { target: null, ambiguous: false, candidates: null };
  const idMatches = [];
  for (const d of storeHandle.listRegistry()) {
    if (d && d.id != null && String(d.id) === String(arg)) idMatches.push(d);
  }
  // EXACT-ID-vs-MESH-ID SHADOW GUARD (P0 fix): an unambiguous exact `id` match
  // must never be silently shadowed by a DIFFERENT row's derived meshId — e.g.
  // row A has id:"foo" and row B's worktreePath derives meshId:"foo". Only
  // short-circuit on byMesh when it is not itself already an idMatches
  // candidate under a different identity than a genuine exact-id match.
  if (idMatches.length === 1) {
    // Compare by `id` (the registry primary key), not object reference —
    // resolveMeshTarget and this loop both re-read storeHandle.listRegistry()
    // independently, so the SAME underlying row can come back as two distinct
    // object instances.
    const sameRow = byMesh && String(byMesh.id) === String(idMatches[0].id);
    // A phantom/live PAIR for the SAME worktree (byMesh preferring the live
    // row over a phantom whose id happens to equal the queried meshId) is
    // NOT a collision — resolveMeshTarget already deliberately picks the live
    // row for exactly this case, and idMatches[0] (the phantom) is itself one
    // of the candidates that pass belonged to that same worktree group. Only
    // treat this as a genuine collision when idMatches[0] belongs to a
    // DIFFERENT worktree than the one `arg` (as a meshId) actually derives
    // to — i.e. its own worktree's derived meshId does not even match `arg`.
    let ownMeshId = null;
    try { ownMeshId = idMatches[0].worktreePath ? inst.primaryWorkspaceId(idMatches[0].worktreePath) : null; } catch (_) { ownMeshId = null; }
    const sameWorktreeGroup = ownMeshId != null && String(ownMeshId) === String(arg);
    if (byMesh && !sameRow && !sameWorktreeGroup) {
      return { target: null, ambiguous: true, candidates: [idMatches[0].id, byMesh.id] };
    }
    if (byMesh && sameWorktreeGroup && !sameRow) return { target: byMesh, ambiguous: false, candidates: null };
    return { target: idMatches[0], ambiguous: false, candidates: null };
  }
  if (idMatches.length > 1) {
    return { target: null, ambiguous: true, candidates: idMatches.map((d) => d.id) };
  }
  if (byMesh) return { target: byMesh, ambiguous: false, candidates: null };
  return { target: null, ambiguous: false, candidates: null };
}

// cmdSend(flags, ctx) — send --from <id> --to <meshId>|--broadcast --message
// TEXT [--urgency low|normal|high|urgent]. Opens store/<repoKey>/ directly.
//
// ORDERING PIN (D28/Fable P2): repoKey is resolved from cwd FIRST — a null
// repoKey (non-git cwd) returns {ok:false,reason:'no-project'} BEFORE any
// identity derivation, so a spoofed DEVSWARM_BUILDER_ID on a non-git cwd can
// NEVER emit an env-derived `from` (callerIdentity is never even reached on
// that path — `no-project` is returned first, unconditionally).
function cmdSend(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };

  // `from` is ALWAYS the hardened, cwd-derived identity (D18/D19) — never raw
  // env. An explicit --from flag is accepted ONLY as a redundant declaration
  // that must MATCH the derived identity; a mismatching one is spoofing and is
  // rejected outright (D18 guard).
  const from = callerIdentity(ctx.env, cwd);
  const fromFlag = one(flags, 'from');
  if (fromFlag !== undefined && fromFlag !== from) {
    return {
      ok: false,
      error: 'send --from ' + JSON.stringify(fromFlag) + ' does not match the '
        + 'caller\'s derived identity ' + JSON.stringify(from) + ' — spoofing rejected',
    };
  }

  const toFlag = one(flags, 'to');
  const broadcastFlag = hasFlag(flags, 'broadcast') || one(flags, 'type') === 'broadcast';
  // --to-primary (v0.58, PLAN.md CLI VERB CONTRACT): a third mutually-exclusive
  // target mode alongside the existing --to <meshId> / --broadcast.
  const toPrimaryFlag = hasFlag(flags, 'to-primary');
  const targetModeCount = (toFlag !== undefined ? 1 : 0) + (broadcastFlag ? 1 : 0) + (toPrimaryFlag ? 1 : 0);
  if (targetModeCount > 1) {
    return { ok: false, error: 'send accepts --to <meshId> OR --to-primary OR --broadcast, not more than one' };
  }
  if (targetModeCount === 0) {
    return { ok: false, error: 'send requires --to <meshId>, --to-primary, or --broadcast' };
  }
  const type = broadcastFlag ? 'broadcast' : 'direct';

  // --question (D-devswarm-parent-decide-gate §4.1): marks this send as a
  // blocking question needing a reply (needs_reply); never valid on a broadcast.
  const questionFlag = hasFlag(flags, 'question');
  if (questionFlag && type === 'broadcast') {
    return { ok: false, error: 'send --question is only valid for a direct message (--to/--to-primary), not --broadcast' };
  }

  const message = one(flags, 'message');
  if (!message) return { ok: false, error: 'send requires --message TEXT' };

  const urgencyRaw = one(flags, 'urgency');
  const urgency = urgencyRaw !== undefined ? urgencyRaw : 'normal';
  if (!ALLOWED_URGENCY.includes(urgency)) {
    return {
      ok: false,
      error: 'send --urgency must be one of ' + ALLOWED_URGENCY.join('|'),
      allowed: ALLOWED_URGENCY.slice(),
    };
  }

  // --to-primary resolution (cheap, no store open needed): the installer helper
  // resolveMainWorktree(cwd) resolves THIS project's main worktree; its meshId
  // is what the fail-closed registry lookup (below, inside the store) and the
  // self-address check (here, mirroring --to's own ordering) both key off.
  let mainWorktree = null;
  let primaryMeshId = null;
  if (toPrimaryFlag) {
    mainWorktree = inst.resolveMainWorktree(cwd);
    if (!mainWorktree) {
      return { ok: false, reason: 'no-primary-worktree', error: 'send --to-primary: cwd is not inside a resolvable git worktree' };
    }
    primaryMeshId = inst.primaryWorkspaceId(mainWorktree);
  }

  if (type === 'direct') {
    const selfTarget = toPrimaryFlag ? primaryMeshId : toFlag;
    if (selfTarget === from) {
      return { ok: false, error: 'send --to' + (toPrimaryFlag ? '-primary' : '') + ' cannot address the sender itself' };
    }
  }

  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  // P1-1/P1-2 RE-HOME (send path): if the Primary is stranded in the legacy hash
  // bucket, MIGRATE it into store/<repoKey>/ BEFORE resolving/delivering, so the
  // message lands in the SAME store the Primary's own read verbs open — the old
  // "Fix 1" band-aid delivered into the hash bucket instead, a silent black hole
  // the Primary's repoKey-keyed reads never drained. GATED exactly like the read
  // path (maybeRehomeToCwdProject): a healthy, already-colocated Primary is a
  // no-op here — no descriptor rewrite, no registry re-upsert, no false
  // `rehomedFromHashBucket:true` on the hot path. Best-effort + under the
  // per-id lock (held internally by maybeRehomeToCwdProject); only a genuinely
  // hash-bucket-stranded Primary re-homes.
  let rehomedSend = false;
  if (toPrimaryFlag) {
    try {
      const rh = maybeRehomeToCwdProject(home, primaryMeshId, ctx);
      rehomedSend = !!(rh && rh.rehomed);
    } catch (_) { /* fail-open: send proceeds and fail-closes below if still unresolved */ }
  }
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  try {
    let targetPartition = null;
    if (type === 'direct') {
      // Fail-closed addressing (D12a): a --to naming neither a registered meshId
      // NOR a registered row id is rejected outright — never a silent
      // black-hole. Same posture for --to-primary: an unregistered Primary is a
      // fail-closed error, never a silent black-hole either. After a re-home
      // (above) the Primary's row is now in THIS repoKey store, so this resolve
      // finds it.
      if (toPrimaryFlag) {
        const target = resolveMeshTarget(s, primaryMeshId);
        if (!target) {
          return {
            ok: false, reason: 'primary-unregistered',
            error: 'send --to-primary: no registered Primary workspace for this project (run `register-primary` first)',
          };
        }
        targetPartition = target.id;
      } else {
        // resolveSendTarget (P0 addressing fix): tries the meshId match FIRST
        // (unchanged), then falls back to an exact match against a row's own
        // `id` — the value `roster` now prints alongside meshId, so a copied
        // roster id addresses correctly instead of failing closed.
        const resolved = resolveSendTarget(s, toFlag);
        if (resolved.ambiguous) {
          return {
            ok: false, reason: 'ambiguous-recipient',
            error: 'send --to ' + JSON.stringify(toFlag) + ' matches more than one registered workspace row ('
              + resolved.candidates.join(', ') + ') — this should never happen (id is the registry primary key); '
              + 'address a specific meshId instead',
          };
        }
        if (!resolved.target) {
          return {
            ok: false, reason: 'unregistered-recipient',
            error: 'send --to ' + JSON.stringify(toFlag) + ' is not a registered mesh workspace',
          };
        }
        // The row's workspace_id is the target's REAL read partition — its
        // builder-id (target.id), NOT the meshId (D19 child-delivery join): this
        // is what lands a mesh direct in the exact partition the recipient (or a
        // child's builder-id read surface, D26) actually reads.
        targetPartition = resolved.target.id;
      }
    }
    const doAppend = () => {
      const fields = {
        from, to: type === 'direct' ? targetPartition : null,
        type, message: String(message), timestamp: now, urgency,
        needsReply: questionFlag,
      };
      const hash = store.meshMessageHash(fields);
      const res = store.appendMeshMessage(s, Object.assign({}, fields, { hash }));
      store.deriveSummary(s, { home, env: ctx.env, now });
      return {
        ok: true, action: 'send', from,
        to: type === 'direct' ? (toPrimaryFlag ? primaryMeshId : toFlag) : null, type, urgency,
        sent: !!res.inserted, seq: res.seq,
        rehomedFromHashBucket: rehomedSend || undefined,
        needsReply: questionFlag,
        toId: type === 'direct' ? targetPartition : null,
      };
    };
    if (type === 'direct') {
      // MESSAGE-LOSS FIX (P1): rehomeAcrossStores always runs under
      // withIdLock(id) (rehomeMiskeyedRow/rehomeCore) while it snapshots this
      // store's messages for `targetPartition` and then tombstones its
      // registry row — but this send was previously entirely unlocked, so it
      // could append a message into `s` AFTER rehome's snapshot but BEFORE its
      // tombstone; message rows are append-only (never deleted), so that
      // append survives here while the registry row that would have made it
      // reachable is gone — permanently orphaned in the old store. Serializing
      // on the SAME per-id lock forces this append to wait out any in-flight
      // rehome of this exact id. Re-check the row is still HERE once the lock
      // is ours: a rehome that completed while we waited has already moved it
      // to another store, and appending here regardless would just re-create
      // the same orphan one step later.
      return withIdLock(String(targetPartition), home, () => {
        const stillHere = (s.listRegistry() || []).some((row) => row && String(row.id) === String(targetPartition));
        if (!stillHere) {
          return {
            ok: false, reason: 'unregistered-recipient',
            error: 'send target ' + JSON.stringify(targetPartition) + ' is no longer registered in this '
              + 'project store (likely re-homed to another project store mid-send) — retry',
          };
        }
        return doAppend();
      });
    }
    return doAppend();
  } finally { s.close(); }
}

// LIST_CHILDREN_TIMEOUT_MS — bounded timeout for roster's read-only native
// fold spawn (`hivecontrol workspace list children`). Mirrors the finite-
// timeout posture every other hivecontrol spawn in this codebase uses
// (devswarm-pull.js's message-count/read-messages, child-gate.js's
// probeNativeMessageCount) — a hung/slow native CLI must never wedge `roster`.
const LIST_CHILDREN_TIMEOUT_MS = 5000;

// parseChildrenList(raw) -> [{branch,id,path,repositoryId}]. TOLERANT parse of
// `hivecontrol workspace list children`/`list all` output — the JSON shape is
// not pinned in the KB, so accept a bare array or a {children:[...]} wrapper
// (same tolerance the old, now-deleted resolveChildBranch used for the same
// command). Shared by fetchNativeChildren (`list children`) AND
// fetchTrustedRepositoryId (`list all`) below — both commands return the same
// per-record shape (live-verified).
function parseChildrenList(raw) {
  let list = [];
  try {
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.children) ? parsed.children : []);
  } catch (_) { list = []; }
  return list.filter((e) => e && typeof e === 'object').map((e) => ({
    branch: e.branch || e.id || null,
    id: e.id || null,
    path: e.path || e.worktreePath || null,
    // label (task #6): hivecontrol's free-text human title — live-verified
    // present on `list children`/`list all` output, DEFAULTS to the branch
    // name when `-t` was not passed at create. Previously dropped by this
    // parse; now threaded through fetchNativeChildren/cmdRoster so a native
    // child's human name is visible instead of just its branch/id.
    label: (typeof e.label === 'string' && e.label) ? e.label : null,
    // repositoryId (cross-repo hijack guard, see fetchNativeChildren below):
    // hivecontrol's own internal repo identity for this record — live-verified
    // present on both `list children` and `list all` output.
    repositoryId: (typeof e.repositoryId === 'string' && e.repositoryId) ? e.repositoryId : null,
  }));
}

// fetchTrustedRepositoryId(ctx, run) -> string|null. ONE bounded, CWD-ANCHORED
// `hivecontrol workspace list all` spawn with DEVSWARM_REPO_ID stripped from
// the env it's given, so hivecontrol is forced onto its cwd-based resolution
// fallback (live-verified correct: unsetting all DEVSWARM_* vars makes
// `list all` resolve the repo from the real worktree cwd, not an ambient env
// var). Used ONLY as ground truth for fetchNativeChildren's cross-check below.
// Fail-open null: hivecontrol not installed / spawn error / unparseable /
// empty output all read as "no trusted id available".
function fetchTrustedRepositoryId(ctx, run) {
  try {
    let env = ctx.env;
    if (env && Object.prototype.hasOwnProperty.call(env, 'DEVSWARM_REPO_ID')) {
      env = Object.assign({}, env);
      delete env.DEVSWARM_REPO_ID;
    }
    const res = run({ args: ['workspace', 'list', 'all'], env, timeout: LIST_CHILDREN_TIMEOUT_MS });
    if (!res || !res.ok) return null;
    const found = parseChildrenList(res.raw).find((e) => e.repositoryId);
    return found ? found.repositoryId : null;
  } catch (_) {
    return null;
  }
}

// fetchNativeChildren(ctx) -> [{branch,id,path}]. ONE bounded, NON-DESTRUCTIVE
// `hivecontrol workspace list children` spawn (never `monitor`/`read-messages`),
// using the SAME injectable io.run posture as every other native spawn in this
// file (pull.defaultRun). Fail-open []: hivecontrol not installed / spawn error
// / unparseable output all read as "nothing to fold" — roster's own store-only
// view is NEVER blocked or degraded by this best-effort addition.
//
// CROSS-REPO HIJACK GUARD (defense-in-depth): `list children` resolves its
// "current workspace" scope ENTIRELY from env (DEVSWARM_REPO_ID +
// DEVSWARM_BUILDER_ID), never from cwd — live-verified: a Node process that
// inherited a FOREIGN repo's DEVSWARM_REPO_ID (+ a matching foreign
// DEVSWARM_BUILDER_ID) gets that OTHER repo's real children back, exit 0,
// valid JSON, with this process's cwd sitting in a completely unrelated repo
// the whole time. (`list children` also REQUIRES DEVSWARM_REPO_ID to run at
// all — it errors "Not inside a DevSwarm workspace" without it — so stripping
// the env here, as an earlier version of this fix did, breaks the call
// entirely instead of hardening it; that approach was live-verified wrong and
// reverted.) Each returned record's `repositoryId` is cross-checked against a
// SEPARATE, cwd-anchored lookup (fetchTrustedRepositoryId, env-stripped
// `list all`) and any mismatch is dropped + logged rather than silently
// folded into this repo's roster. If no trusted id can be established, or no
// record carries a repositoryId at all (older hivecontrol), the fold degrades
// to its pre-existing unfiltered behavior — never a crash, never a hard
// failure.
function fetchNativeChildren(ctx) {
  try {
    const run = (ctx.io && ctx.io.run) || pull.defaultRun;
    const res = run({ args: ['workspace', 'list', 'children'], env: ctx.env, timeout: LIST_CHILDREN_TIMEOUT_MS });
    if (!res || !res.ok) return [];
    const children = parseChildrenList(res.raw);
    const withRepoId = children.filter((c) => c.repositoryId);
    if (withRepoId.length === 0) return children; // nothing to cross-check against
    const trusted = fetchTrustedRepositoryId(ctx, run);
    if (!trusted) return children; // no ground truth available -> fail open, unfiltered
    const mismatched = withRepoId.filter((c) => c.repositoryId !== trusted);
    if (mismatched.length) {
      try {
        alog.logEvent('devswarm-cli', 'roster-native-fold', 'warn',
          'dropped ' + mismatched.length + ' native child(ren) whose repositoryId did not match this repo (cross-repo env hijack guard)',
          { expected: trusted, got: Array.from(new Set(mismatched.map((c) => c.repositoryId))) });
      } catch (_) {}
    }
    return children.filter((c) => !c.repositoryId || c.repositoryId === trusted);
  } catch (_) {
    return [];
  }
}

// cmdRoster(flags, ctx) — ALLOW-listed projection read of THIS project's
// shared registry + `working_on` (D3 roster surface). Derives a FRESH summary
// (never a stale cache) from store/<repoKey>/, keyed purely off cwd — no id
// argument, project-scoped like `send`/`mesh read`.
//
// v0.58 roster fold: additionally unions a READ-ONLY `hivecontrol workspace
// list children` view into the projection (never written back to the store —
// the store registry stays the single write-owned source of truth). A native
// child not yet matched by worktreePath against the store set (i.e. one that
// has never registered itself via inbox pull/heartbeat/register) is appended
// as a minimal entry so it is still VISIBLE on the roster instead of invisible.
// rosterIdleDays(home, id, now) — READ-ONLY reuse of the persisted liveness
// verdict (the SAME `livenessPathFor`/JSON shape `computeLiveness` itself
// reads, liveness.js:129) to surface "days since last activity" on the
// roster, without any new heavy computation. Returns null (never fabricated)
// when no verdict exists yet or it carries no usable timestamp.
function rosterIdleDays(home, id, now) {
  try {
    const v = JSON.parse(fs.readFileSync(livenessPathFor(id, home), 'utf8'));
    if (v && Number.isFinite(v.lastOutboundTs)) {
      const days = Math.floor(((Number.isFinite(now) ? now : Date.now()) - v.lastOutboundTs) / 86400000);
      if (days >= 0) return days;
    }
  } catch (_) { /* no verdict yet / unreadable — fail-open, no fabricated value */ }
  return null;
}

// cmdRoster's per-row hints (archive-candidate surfacing, read-only): does
// NOT gate/skip anything and writes nothing — purely annotates the SAME
// projection so a human can decide whether to run the already-shipped
// `archive <id>` verb. `worktree-gone` = the descriptor's worktreePath no
// longer exists on disk (existsSync, same check style as elsewhere in this
// file). `idle Nd` = days since last liveness activity, when known.
function rosterHints(home, id, worktreePath, now) {
  const hints = [];
  if (worktreePath && !fs.existsSync(worktreePath)) hints.push('worktree-gone');
  const idleDays = rosterIdleDays(home, id, now);
  if (idleDays !== null) hints.push('idle ' + idleDays + 'd');
  return hints;
}

// rosterMeshId(worktreePath) -> the SAME raw worktree-derived meshId
// resolveMeshTarget's own matching loop computes (`inst.primaryWorkspaceId
// (d.worktreePath)`, no toplevel canonicalization) — NOT `canonicalMeshId`
// (the toplevel-folded value `diagnose`'s split-detection/grouping uses,
// which is a DIFFERENT value for a subdir-registered row). Surfacing THIS
// exact value is what closes the send addressing footgun (P0): a value
// copied from here into `send --to <meshId>` is guaranteed to hit
// resolveMeshTarget's existing meshId-hash match path. null when there is no
// worktreePath to derive one from (a phantom/native-only/archived row).
function rosterMeshId(worktreePath) {
  if (!worktreePath) return null;
  try { return inst.primaryWorkspaceId(worktreePath); } catch (_) { return null; }
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
  try {
    if (id == null || !isSafeId(String(id))) return false;
    if (fs.existsSync(descriptorPath(home, String(id)))) return false; // still live
    const ad = checkedArchivedDir(home);
    if (!ad.ok || !ad.exists) return false;
    return fs.existsSync(path.join(ad.path, String(id) + '.json'));
  } catch (_) { return false; }
}

function cmdRoster(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let sum;
  // #62: a READ verb must not mutate — PURE computeSummary (no summary.json write).
  try { sum = store.computeSummary(s, { home, env: ctx.env, now: ctx.now }); }
  finally { s.close(); }
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const workspaces = Object.values(sum.workspaces || {}).map((w) => {
    // DEMOTE (archived-still-active fix): a store-sourced row whose workspace is
    // genuinely archived is labeled source:'archived' + hinted, instead of being
    // reported as a live 'store' row. The row is still SHOWN (nothing is hidden
    // or deleted — same no-delete posture as the archived/ scan below); only its
    // label changes, so an archived workspace can no longer read as active.
    const archivedOnly = isArchivedOnlyWorkspace(home, w.id);
    const hints = rosterHints(home, w.id, w.worktreePath, now);
    if (archivedOnly) hints.unshift('archived');
    return {
      id: w.id, working_on: w.working_on, directUnread: w.directUnread,
      broadcastUnread: w.broadcastUnread, urgencyMax: w.urgencyMax,
      worktreePath: w.worktreePath || null, source: archivedOnly ? 'archived' : 'store',
      meshId: rosterMeshId(w.worktreePath),
      hints,
      // wsName (task #6): cached human display name, read-only fs projection
      // (never a hivecontrol spawn on this read verb) — null when not yet
      // cached (backfilled by cmdReconcile, or set at spawn time).
      wsName: names.readName(home, w.id),
    };
  });
  // Dedup by CANONICAL identity (inst.primaryWorkspaceId, which realpath-
  // normalizes before hashing), not raw string equality — the same fix class
  // as resolvePrimaryTarget: a raw `--show-toplevel` spelling and a
  // canonicalized one for the SAME real directory must collapse to one row.
  const knownIds = new Set(workspaces.map((w) => w.worktreePath).filter(Boolean).map((p) => inst.primaryWorkspaceId(p)));
  const nativeChildren = fetchNativeChildren(ctx);
  for (const child of nativeChildren) {
    if (child.path && knownIds.has(inst.primaryWorkspaceId(child.path))) continue; // already represented via the store
    const id = child.branch || child.id || null;
    workspaces.push({
      id, working_on: null,
      directUnread: null, broadcastUnread: null, urgencyMax: null,
      worktreePath: child.path || null, source: 'native',
      meshId: rosterMeshId(child.path || null),
      hints: rosterHints(home, id, child.path || null, now),
      // wsName: hivecontrol's own `label`, straight from this native fold —
      // no fs cache lookup needed here, we already have the live value.
      wsName: child.label || null,
    });
  }
  // Fix 1 (split-brain heal, READ-ONLY): a Primary registered into the LEGACY
  // hash bucket store/<hashFromWorkspaceId(primary-<hash>)>/ (when repoKey was
  // transiently null at register time) is invisible to the repoKey-keyed
  // computeSummary above — the roster would read "no primary". If this project's
  // Primary is NOT already represented, fold in its hash-bucket entry so it is
  // surfaced (labeled source:'store-fallback'). Pure read: never writes into
  // either store. Fail-open: any error leaves the base roster untouched.
  //
  // P2-9: read the hash bucket's ALREADY-DERIVED summary.json via
  // store.readSummaryForHash — NOT openStore()+computeSummary, which MATERIALIZES
  // the bucket (dir/DB/WAL/schema) as a side effect of a pure read verb. A bucket
  // that does not exist reads as null (no fold), creating nothing.
  try {
    const main = inst.resolveMainWorktree(cwd);
    if (main) {
      const primaryMeshId = inst.primaryWorkspaceId(main);
      const fallbackHash = store.hashFromWorkspaceId(primaryMeshId);
      const alreadyKnown = knownIds.has(primaryMeshId) || workspaces.some((w) => w.id === primaryMeshId);
      if (fallbackHash && fallbackHash !== repoKey && !alreadyKnown) {
        const sum2 = store.readSummaryForHash(home, fallbackHash);
        const pw = sum2 && sum2.workspaces && sum2.workspaces[primaryMeshId];
        if (pw) {
          workspaces.push({
            id: pw.id, working_on: pw.working_on, directUnread: pw.directUnread,
            broadcastUnread: pw.broadcastUnread, urgencyMax: pw.urgencyMax,
            worktreePath: pw.worktreePath || null, source: 'store-fallback',
            meshId: rosterMeshId(pw.worktreePath),
            hints: rosterHints(home, pw.id, pw.worktreePath, now),
            wsName: names.readName(home, pw.id),
          });
        }
      }
    }
  } catch (_) { /* fail-open: the split-brain fallback fold never breaks the base roster */ }
  // Read-only, fail-open scan of archived/ so an already-archived id stays
  // VISIBLE on the roster (labeled, never re-written — archived/ remains a
  // pure move target; this never folds back into the store registry).
  const knownRosterIds = new Set(workspaces.map((w) => w.id).filter(Boolean));
  let archivedNames = [];
  const archiveDirState = checkedArchivedDir(home);
  if (archiveDirState.ok && archiveDirState.exists) {
    try { archivedNames = fs.readdirSync(archiveDirState.path); } catch (_) { archivedNames = []; }
  }
  for (const n of archivedNames) {
    if (!/\.json$/.test(n)) continue;
    const id = n.slice(0, -'.json'.length);
    if (knownRosterIds.has(id)) continue;
    try {
      if (!isSafeId(id)) continue;
      const state = readDescriptorPathState(path.join(archiveDirState.path, n));
      const d = state.descriptor;
      if (!d || String(d.id) !== id || !d.worktreePath) continue;
      const archivedOwnerKey = descriptorPhysicalOwnerKey(d);
      if (!archivedOwnerKey || archivedOwnerKey !== repoKey) continue;
    } catch (_) { continue; }
    workspaces.push({
      id, working_on: null, directUnread: null, broadcastUnread: null, urgencyMax: null,
      worktreePath: null, source: 'archived', meshId: null, hints: ['archived'],
    });
  }
  return { ok: true, action: 'roster', repoKey, count: workspaces.length, workspaces, recent: sum.recent || [] };
}

// cmdDiagnose(flags, ctx) — READ-ONLY mesh-health projection (#62). Uses the PURE
// store.computeSummary (ZERO summary.json write) plus the shared registry to show,
// per worktree: each registry row (id, worktreePath, sessionId, unread, live?),
// which partition a `send` to that worktree's meshId resolves to (resolveMeshTarget
// — the SAME freshest-live routing `send` uses), the orphan partitions +
// stale-registry rows computeSummary surfaces (Phase A), and any worktree carrying
// 2+ LIVE rows flagged as a "split" (the un-converged case a submodule / separate
// git root shows up as — surfaced here, NEVER auto-merged). Project-scoped like
// roster (no id arg, keyed off cwd's repoKey). Purity is the point: an orchestrator
// can SEE mesh state without the read itself mutating anything.
// computeDiagnosis(s, ctx) — the ONE mesh-health computation shared by cmdDiagnose,
// cmdHealthcheck (#71), and the doctor mesh-shape CHECK. Takes an OPEN store handle
// `s` (pure — computeSummary NEVER writes summary.json) and returns the fully
// derived pieces; callers add their own envelope + presentation. Groups via the
// shared groupRegistryByMeshId (canonical git-toplevel identity, so subdir-splits
// fold), so `send --to <meshId>` routing (resolveMeshTarget) and split detection
// agree with the fold. Adds two aggregate counts not surfaced by `diagnose`'s object
// today: `phantoms` (rows with no live sessionId) and `unreadTotal` (Σ directUnread).
function computeDiagnosis(s, ctx) {
  const c = ctx || {};
  const sum = store.computeSummary(s, { home: c.home, env: c.env, now: c.now });
  const registry = s.listRegistry();
  const byMesh = groupRegistryByMeshId(registry);
  const meshTargets = [];
  const splits = [];
  for (const g of byMesh.values()) {
    const target = resolveMeshTarget(s, g.meshId); // the partition `send --to <meshId>` lands in
    const split = g.liveRows >= 2;
    if (split) splits.push(g.meshId);
    meshTargets.push({ meshId: g.meshId, resolvesTo: target ? target.id : null, ids: g.ids, liveRows: g.liveRows, split });
  }
  const workspaces = sum.workspaces || {};
  const rows = registry.filter((d) => d && d.id != null).map((d) => {
    const w = workspaces[d.id] || {};
    return {
      id: d.id,
      worktreePath: d.worktreePath || null,
      sessionId: d.sessionId || null,
      live: isLiveSessionId(d.sessionId),
      unread: Number.isFinite(w.unread) ? w.unread : 0,
    };
  });
  const phantoms = rows.filter((r) => !r.live).length;
  let unreadTotal = 0;
  for (const id of Object.keys(workspaces)) {
    const w = workspaces[id];
    if (w && Number.isFinite(w.directUnread)) unreadTotal += w.directUnread;
  }
  return {
    sum, registry: rows, meshTargets, splits,
    orphans: sum.orphans || [],
    staleRegistryPartitions: sum.staleRegistryPartitions || [],
    phantoms, unreadTotal,
  };
}

function cmdDiagnose(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let d;
  try { d = computeDiagnosis(s, { home, env: ctx.env, now: ctx.now }); } finally { s.close(); }
  return {
    ok: true, action: 'diagnose', repoKey,
    count: d.registry.length, registry: d.registry,
    meshTargets: d.meshTargets, splits: d.splits,
    orphans: d.orphans,
    staleRegistryPartitions: d.staleRegistryPartitions,
  };
}

// cmdHealthcheck(flags, ctx) — #71: a scriptable PASS/FAIL gate over the SAME data
// `diagnose` computes (computeDiagnosis — one source, two presentations). Unlike
// `diagnose` (always ok:true — a report), this turns mesh-shape drift into an exit
// signal: ok/exit 0 when healthy, ok:false/exit non-zero when degraded.
//   counts = { orphans, stale, splits, phantoms, unreadTotal }.
//   degraded iff orphans>0 || stale>0 || splits>0 (STRUCTURAL drift only) —
//   phantoms (a spawn-time placeholder, benign/transient) and unreadTotal (normal
//   mailbox backlog) are reported for visibility but NEVER gate, so a freshly-
//   spawned worktree does not trip a false "degraded". Pure read (zero writes).
function cmdHealthcheck(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let d;
  try { d = computeDiagnosis(s, { home, env: ctx.env, now: ctx.now }); } finally { s.close(); }
  const counts = {
    orphans: d.orphans.length,
    stale: d.staleRegistryPartitions.length,
    splits: d.splits.length,
    phantoms: d.phantoms,
    unreadTotal: d.unreadTotal,
  };
  const degraded = counts.orphans > 0 || counts.stale > 0 || counts.splits > 0;
  return {
    ok: !degraded, action: 'healthcheck', repoKey,
    status: degraded ? 'degraded' : 'ok',
    counts,
    detail: {
      orphans: d.orphans,
      staleRegistryPartitions: d.staleRegistryPartitions,
      splits: d.splits,
    },
  };
}

// healthcheckHumanLine(result) — the DEFAULT (non-`--json`) render of `healthcheck`:
// one compact line. `--json` prints the raw JSON object (main() decides which).
function healthcheckHumanLine(r) {
  if (!r || typeof r !== 'object') return String(r);
  if (r.reason === 'no-project') return 'healthcheck: no-project (cwd is not inside a DevSwarm project)';
  const c = r.counts || {};
  const parts = [
    'orphans=' + (c.orphans || 0),
    'stale=' + (c.stale || 0),
    'splits=' + (c.splits || 0),
    'phantoms=' + (c.phantoms || 0),
    'unread=' + (c.unreadTotal || 0),
  ];
  return 'healthcheck: ' + (r.status || (r.ok ? 'ok' : 'degraded')) + ' [' + parts.join(' ') + ']';
}

// cmdMeshRead(flags, ctx) — a.k.a. `roster --ack` (D23). Lists the CALLER's
// unseen NON-heartbeat broadcasts (its own broadcast_cursors join point up to
// the shared broadcast partition's current `seq` head), then advances the
// CALLER's OWN broadcast_cursors to head — the ONLY surface that clears
// `broadcastUnread`. `deriveSummary` re-scans only the bounded broadcast
// partition tail (recentCap), never an unbounded history.
function cmdMeshRead(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const from = callerIdentity(ctx.env, cwd);
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  try {
    // v0.57 mesh (P1 fix, same root cause as the ack-ownership P0): the broadcast
    // cursor must be keyed by the caller's OWN REGISTERED partition id (d.id) —
    // the SAME id deriveSummary reads back via store.broadcastCursorValue(d.id)
    // (devswarm-store.js) — never the raw worktree-derived meshId `from`. These
    // coincide only for a self-registered Primary; for a child (registered under
    // its DEVSWARM_BUILDER_ID) they diverge, so acking broadcasts via this ONLY
    // documented clearing path (D23) advanced a cursor deriveSummary never reads,
    // leaving broadcastUnread stuck forever despite `ok:true, acked:true`. Resolve
    // the caller's own registry entry the same way the ack-ownership guard does
    // (resolveMeshTarget keyed by the caller's meshId); fall back to `from` itself
    // when unregistered (no store entry at all) — the pre-existing, still-correct
    // behavior for that case.
    const ownEntry = resolveMeshTarget(s, from);
    const cursorKey = ownEntry ? ownEntry.id : from;
    const cursor = typeof s.broadcastCursorValue === 'function' ? s.broadcastCursorValue(cursorKey) : 0;
    const all = typeof s.listMessages === 'function' ? s.listMessages(store.BROADCAST_PARTITION_ID) : [];
    // Filtered on the PHYSICAL mesh `seq` (storeSeq), matching broadcast_cursors'
    // own semantics (deriveSummary's broadcastUnread, D22/D23) — NOT the
    // per-workspace positional `sinceCursor` listMessages() otherwise supports.
    const broadcasts = all
      .filter((r) => !r.isHeartbeat && Number.isFinite(r.storeSeq) && r.storeSeq > cursor)
      .map((r) => ({ from: r.sender, message: r.body, timestamp: r.ts, urgency: r.urgency, seq: r.storeSeq }));
    const newCursor = typeof s.advanceBroadcastCursor === 'function' ? s.advanceBroadcastCursor(cursorKey) : cursor;
    store.deriveSummary(s, { home, env: ctx.env, now });
    return { ok: true, action: 'mesh-read', from, acked: true, newCursor, count: broadcasts.length, broadcasts };
  } finally { s.close(); }
}

// ============================================================================
// v0.58 lifecycle wrappers (reconcile / spawn / merge) — PLAN.md CLI VERB
// CONTRACT. spawn/merge are THIN pass-through wraps: hivecontrol's own flag
// grammar is NEVER re-parsed by this file's `parseArgs` (which only recognizes
// `--long` flags) — the dispatcher instead hands these two verbs the RAW
// argv tail (see `run()` below), so every hivecontrol flag (present or future,
// short OR long form, e.g. `-p`/`--prompt`) forwards byte-for-byte.
// ============================================================================

// defaultSpawnReconcile(d, ctx) -> spawnSync result. Spawns THIS SAME script
// (`__filename`, via `process.execPath` — an ABSOLUTE resolved binary path,
// NOT a bare command name) as a subprocess with `cwd: d.worktreePath`, running
// `inbox pull <d.id>` there. Verified-before-build: hooks/devswarm-child-gate.js's
// `shell: process.platform === 'win32'` precedent applies ONLY to a bare
// command name (`hivecontrol`) that depends on Windows PATHEXT shim
// resolution (a `.cmd`/`.bat` global-CLI shim); `process.execPath` is already
// the resolved node binary, so no shell is needed here — same posture as this
// file's own `defaultSpawnInstaller` a few hundred lines up, which spawns
// itself the identical way.
// WINDOWS BUG (CI run investigated for v0.66.1): `HOME` alone does NOT
// redirect a Node child's `os.homedir()` on win32 — Node reads `USERPROFILE`
// there (POSIX-only reads `$HOME`; see Node's os.homedir() docs). This
// subprocess's own `cmdInboxPull`/`pullOnce` call resolves ITS `home` via
// exactly that same `ctx.home || os.homedir()` fallback, so on Windows the
// spawned `inbox pull` silently ignored `ctx.home` and fell back to the
// REAL OS home directory instead — breaking the one guarantee this spawn
// exists to provide (the child observes the SAME devswarm root, including
// the SAME per-id pull lock, as the caller) whenever `ctx.home` differs from
// the live process's actual home. Same fix hooks/doctor.js's own child-env
// builder (CHILD_ENV/PRIMARY_ENV) already applies for the identical reason.
function defaultSpawnReconcile(d, ctx) {
  const env = Object.assign({}, ctx.env || process.env, { HOME: ctx.home, USERPROFILE: ctx.home });
  if (ctx.backend) env.ANTIHALL_DEVSWARM_STORE_BACKEND = ctx.backend;
  try {
    return spawnSync(process.execPath, [__filename, 'inbox', 'pull', d.id], {
      cwd: d.worktreePath, env, encoding: 'utf8', timeout: 30000,
    });
  } catch (e) {
    return { error: e };
  }
}

// cmdReconcile(flags, ctx) — PLAN.md "reconcile": drain EVERY worktree
// registered in THIS project's shared store once. Each `inbox pull` MUST run
// with that worktree as its OWN process cwd (never in-process) — inbox pull's
// native spawns (devswarm-pull.js -> hivecontrol) resolve their target
// workspace from the CALLING process's cwd, so an in-process call from the
// reconciler's own cwd would silently drain the WRONG (the caller's own)
// queue for every descriptor instead of each worktree's own. A per-id O_EXCL
// pull lock (already shipped in devswarm-pull.js's acquireExclLock) serializes
// a reconcile sweep against a live child concurrently pulling its own inbox —
// surfaced here as `locked:true` on that descriptor's result, never silently
// dropped from the count.
function cmdReconcile(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };

  // GH1: re-home any hash-bucket-stranded child of THIS project into store/<repoKey>/
  // BEFORE the listRegistry sweep — otherwise a stranded child is invisible to
  // listRegistry, its `inbox pull` is never spawned, and its backlog never drains.
  try { rehomeStrandedProjectDescriptors(home, ctx); } catch (_) { /* fail-open: reconcile proceeds */ }

  // Claim 3 self-heal pre-pass: heal a row whose descriptor's own real
  // worktreePath disagrees with the store it is physically sitting in
  // (healRegistry/rehomeMiskeyedRow) BEFORE listing targets — a correctly-
  // owned row with stale persisted ownerKey/repoKey metadata is corrected in
  // place (still targeted, correctly, by THIS sweep); a genuinely mis-keyed
  // row is rehomed OUT into its real store and correctly excluded from this
  // project's targets (it will be reconciled by ITS OWN project instead).
  // Fail-open: a heal-pass hiccup must never abort reconcile itself.
  let healed = null;
  try { healed = healRegistry(home, repoKey, ctx); } catch (_) { healed = null; }

  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let descriptors;
  try { descriptors = s.listRegistry(); } finally { s.close(); }

  const targets = descriptors.filter((d) => d && d.worktreePath && isSafeId(d.id));
  const spawnFn = (ctx.io && ctx.io.spawnReconcile) || defaultSpawnReconcile;
  const results = [];
  for (const d of targets) {
    const r = spawnFn(d, ctx);
    let parsed = null;
    if (r && !r.error && typeof r.stdout === 'string') {
      try { parsed = JSON.parse(r.stdout); } catch (_) { parsed = null; }
    }
    results.push({
      id: d.id,
      worktreePath: d.worktreePath,
      ok: !!(parsed && parsed.ok),
      imported: (parsed && parsed.imported) || 0,
      duplicate: (parsed && parsed.duplicate) || 0,
      nativeCount: (parsed && parsed.nativeCount) || 0,
      // P1 fix: pullOnce's loss check (devswarm-pull.js ~line 299) reports a
      // REAL shortfall (native message-count > what actually landed durably)
      // via `lost`. Previously dropped here entirely, so a lossy child pull
      // (e.g. `{ok:false, locked:true, nativeCount:2, lost:2}`) vanished
      // without a trace and the aggregate below still reported `ok:true`.
      // Distinct from `locked` (benign contention skip, never a loss).
      lost: (parsed && parsed.lost) || 0,
      // P1 fix: pullOnce's own contract (devswarm-pull.js) uses `locked===false`
      // to mean "another consumer holds the lock" (same polarity as migrate-
      // state.js's `ds.locked===false` convention) — a blind pass-through of
      // `parsed.locked` was TRUE for an ordinary successful/failed-after-acquire
      // pull and FALSE only on genuine contention: the opposite of what a reader
      // of a per-target reconcile result expects from a field named `locked`.
      // Recompute with the intuitive polarity: true ONLY on the exact
      // genuine-contention shape pullOnce/`inbox pull` emits.
      locked: !!(parsed && parsed.ok === false && parsed.locked === false
        && /holds the lock/i.test(String(parsed.error || ''))),
      // v0.66 P0-2 fix: `hivecontrol` (the native DevSwarm.app CLI) is an
      // OPTIONAL runtime dependency — CI runners (ubuntu/macos/windows) never
      // have it on PATH, so pullOnce's very first native call (message-count,
      // devswarm-pull.js ~line 224) fails with the exact, stable Node spawn
      // shape `spawnSync hivecontrol ENOENT` (or EACCES/ENOTDIR for a broken
      // install) surfaced verbatim as `parsed.error`. That is an ENVIRONMENT
      // fact, not a reconcile defect — same benign-skip posture as `locked`
      // (lock contention): known, recognized, and MUST NOT fail the sweep.
      // A different failure at any OTHER hivecontrol call site, or any error
      // string that doesn't match this exact spawn-failure shape, still fails
      // `ok` normally (deny-list polarity preserved).
      hivecontrolMissing: !!(parsed && parsed.ok === false
        && /^spawnSync\s+\S*hivecontrol\S*\s+(ENOENT|EACCES|ENOTDIR)\b/i.test(String(parsed.error || ''))),
      error: (parsed && parsed.error)
        || (r && r.error ? String((r.error && r.error.message) || r.error) : null)
        || (parsed ? null : 'reconcile: could not parse inbox-pull subprocess output'),
    });
  }
  const imported = results.reduce((acc, r) => acc + (r.imported || 0), 0);
  const lost = results.reduce((acc, r) => acc + (r.lost || 0), 0);
  // rejected: surfaced for VISIBILITY only (a targeted regex over the
  // subprocess's own error string) — NOT the basis for `ok` below anymore
  // (A4, 3rd recurrence at this site): an allow-listed regex necessarily
  // misses every OTHER failure shape (a spawn crash, a timeout, an ENOENT
  // vanished-worktree cwd, unparseable stdout) — each of THOSE left `parsed`
  // null, `r.ok` false, yet neither `lost` nor this regex counted them, so
  // `lost===0 && rejected===0` could read an all-targets-failed sweep as a
  // healthy `imported:0`.
  const rejected = results.filter((r) => !r.ok && /does not belong to the current project/.test(String(r.error || ''))).length;
  // A4 FIX: aggregate `ok` is a DENY-list of benignity, not an allow-list of
  // known failure shapes — every row must be genuinely `ok:true`, OR match
  // ONE of the two recognized benign skips this file already computes with
  // intuitive polarity (`locked:true` — genuine pull-lock contention, never a
  // loss; `hivecontrolMissing:true` — v0.66 P0-2, the optional native binary
  // is absent from this environment, e.g. every CI runner). Any other
  // false-`ok` row (rejection, lossy pull, crash, timeout, a DIFFERENT ENOENT
  // not matching the exact hivecontrol-spawn shape, unparseable stdout —
  // anything at all) fails the aggregate. Never add a third allow-listed
  // failure regex here.
  const allRowsOkOrBenign = results.every((r) => r.ok === true || r.locked === true || r.hivecontrolMissing === true);

  // Task #6 name backfill (off the hot path — reconcile is a gated/manual
  // sweep, NEVER the every-turn hook, so a `hivecontrol` spawn here is fine).
  // ONE batch `workspace list all` call resolves every target's CURRENT label
  // in one spawn (not N per-id spawns) — this is the GENERAL backfill path:
  // it catches a pre-existing workspace with no name at all, AND a workspace
  // whose label ended up as hivecontrol's own branch-name default (cmdSpawn's
  // -t injection only covers the two cases where a title was known at spawn
  // time). Best-effort: hivecontrol missing/erroring/unparseable -> no
  // backfill this sweep, NEVER fails reconcile itself (same fail-open posture
  // as `healed` above).
  let namesBackfilled = 0;
  try {
    const missingNames = targets.filter((d) => !names.readName(home, d.id));
    if (missingNames.length > 0) {
      const listRun = (ctx.io && ctx.io.run) || pull.defaultRun;
      const lr = listRun({ args: ['workspace', 'list', 'all'], env: ctx.env, cwd, timeout: LIST_CHILDREN_TIMEOUT_MS });
      if (lr && lr.ok) {
        const all = parseChildrenList(lr.raw); // reuses the SAME tolerant parse + label field
        const labelById = new Map(all.filter((e) => e.id).map((e) => [e.id, e.label]));
        for (const d of missingNames) {
          const label = labelById.get(d.id);
          if (label && names.writeName(home, d.id, label, ctx.now)) namesBackfilled++;
        }
      }
    }
  } catch (_) { /* fail-open: reconcile proceeds without name backfill */ }

  const out = {
    ok: allRowsOkOrBenign, action: 'reconcile', repoKey,
    count: results.length, imported, lost, rejected, results,
  };
  if (healed) out.healed = healed;
  if (namesBackfilled) out.namesBackfilled = namesBackfilled;
  return out;
}

// readPersistedVerdictStatus(id, home) -> status string | null. READ-ONLY reuse
// of the supervisor's already-written per-workspace verdict file (the SAME
// livenessPathFor/JSON shape computeLiveness reads). No git, no computeLiveness,
// no store DB open. null when absent/unreadable/unsafe id (fail-safe: no verdict
// = not a reap candidate on the liveness axis).
function readPersistedVerdictStatus(id, home) {
  try {
    const v = JSON.parse(fs.readFileSync(livenessPathFor(id, home), 'utf8'));
    return v && typeof v.status === 'string' ? v.status : null;
  } catch (_) { return null; }
}

// hasRecentWorktreeActivity(worktreePath, now, idleMs) -> bool. A SAFETY guard for
// the reaper: true iff the worktree still exists on disk AND has a git commit
// within idleMs. worktreeActivityMtime returns the last git-commit ts (or null
// when there is no reliable git signal), so a live-but-recently-committed worktree
// is never reaped even if a stale verdict lingers from before that activity.
function hasRecentWorktreeActivity(worktreePath, now, idleMs) {
  if (!worktreePath) return false;
  let exists = false;
  try { exists = fs.existsSync(worktreePath); } catch (_) { exists = false; }
  if (!exists) return false;
  const wMtime = worktreeActivityMtime(worktreePath);
  return wMtime !== null && (now - wMtime) <= idleMs;
}

// projectScopedDescriptors(home, repoKey) -> [descriptor] belonging to THIS
// project (physical ownerKey === repoKey), path-safe id + worktreePath present.
// Shared by cmdReapStale and cmdReconcileActive so both scope IDENTICALLY to how
// cmdRoster/cmdArchive scope (descriptorPhysicalOwnerKey === repoKey).
function projectScopedDescriptors(home, repoKey) {
  let descriptors = [];
  try { descriptors = readDescriptors(home) || []; } catch (_) { descriptors = []; }
  return descriptors.filter((d) =>
    d && isSafeId(d.id) && d.worktreePath && descriptorPhysicalOwnerKey(d) === repoKey);
}

// cmdReapStale(flags, ctx) — parent-driven reaper. Archives THIS project's
// workspaces whose persisted liveness verdict is stale/escalated AND which have
// NO fresh heartbeat (definitive proof-of-life) AND no live-worktree+recent-git
// activity. CONFIRM-FIRST (destructive-ish state change): dry-run/preview by
// default (lists what WOULD be archived); requires an explicit --yes / --confirm
// to actually archive. Reuses the proven cmdArchive move+tombstone path per id
// (which re-validates ownership on apply). Project-scoped; requires a git cwd.
function cmdReapStale(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const idleMs = Number.isFinite(ctx.idleThresholdMs) ? ctx.idleThresholdMs : DEFAULT_IDLE_MS;
  const confirm = hasFlag(flags, 'yes') || hasFlag(flags, 'confirm');

  const candidates = [];
  const skipped = [];
  for (const d of projectScopedDescriptors(home, repoKey)) {
    const status = readPersistedVerdictStatus(d.id, home);
    const stale = status === 'stale' || status === 'escalated';
    if (!stale) continue;
    // SAFETY 1: a fresh heartbeat is definitive proof the env is ALIVE — NEVER reap.
    if (hasFreshHeartbeat(d.id, home, { now })) { skipped.push({ id: d.id, reason: 'fresh-heartbeat' }); continue; }
    // SAFETY 2: a live worktree with recent git activity is not abandoned — NEVER reap.
    if (hasRecentWorktreeActivity(d.worktreePath, now, idleMs)) { skipped.push({ id: d.id, reason: 'recent-activity' }); continue; }
    candidates.push({ id: d.id, status, worktreePath: d.worktreePath });
  }

  if (!confirm) {
    return {
      ok: true, action: 'reap-stale', repoKey, dryRun: true,
      count: candidates.length, candidates, skipped,
      note: 'dry-run: pass --yes (or --confirm) to archive these workspaces',
    };
  }
  const archived = [];
  for (const c of candidates) {
    // P1-5: cmdArchive re-validates the safety condition INSIDE its per-id lock,
    // immediately before the archive — so a workspace that heartbeats or commits
    // between candidate collection and here is SKIPPED, not wrong-archived.
    const r = cmdArchive(c.id, ctx, {
      revalidate: (desc) => {
        const nowR = Number.isFinite(ctx.now) ? ctx.now : Date.now();
        const statusR = readPersistedVerdictStatus(c.id, home);
        if (statusR !== 'stale' && statusR !== 'escalated') return 'became-live';
        if (hasFreshHeartbeat(c.id, home, { now: nowR })) return 'fresh-heartbeat';
        if (hasRecentWorktreeActivity(c.worktreePath, nowR, idleMs)) return 'recent-activity';
        // P1-6: re-check structural ownership so a re-keyed/cross-project
        // descriptor is never archived out from under its real project.
        if (desc && descriptorPhysicalOwnerKey(desc) !== repoKey) return 'ownership-changed';
        return null;
      },
    });
    if (r && r.skipped) { skipped.push({ id: c.id, reason: r.reason }); continue; }
    archived.push({ id: c.id, ok: !!r.ok, error: r.error || null });
  }
  return {
    ok: archived.every((a) => a.ok), action: 'reap-stale', repoKey, dryRun: false,
    count: archived.length, archived, skipped,
  };
}

// cmdReconcileActive(flags, ctx) — reconcile the live roster against an explicit
// ACTIVE set. Archives every CURRENT (non-archived) workspace of THIS project NOT
// in the supplied --active id set. Backs the "user says what is still active"
// flow (e.g. from a screenshot). Ids match by FULL id OR a short prefix (how the
// roster displays them) — matching is generous on purpose (a match SPARES a
// workspace, the safe direction: an active workspace is NEVER archived). Refuses
// an EMPTY active set unless --allow-empty (an omitted set must not archive every
// workspace by accident). CONFIRM-FIRST: dry-run by default, --yes/--confirm to
// apply. Reuses cmdArchive per id. Project-scoped; requires a git cwd.
function cmdReconcileActive(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const confirm = hasFlag(flags, 'yes') || hasFlag(flags, 'confirm');

  const activeTokens = csvList(flags, 'active');
  // Optional stdin ids (opt-in only, never auto-read — a blocking fd 0 read on a
  // tty must never wedge the CLI): `--stdin` reads newline/space/comma-separated
  // ids from fd 0. ctx.io.stdin (a string) is the test-injection seam.
  if (hasFlag(flags, 'stdin') || (ctx.io && typeof ctx.io.stdin === 'string')) {
    let raw = '';
    if (ctx.io && typeof ctx.io.stdin === 'string') raw = ctx.io.stdin;
    else { try { raw = String(fs.readFileSync(0, 'utf8')); } catch (_) { raw = ''; } }
    for (const tok of raw.split(/[\s,]+/)) { const t = tok.trim(); if (t && !activeTokens.includes(t)) activeTokens.push(t); }
  }
  if (activeTokens.length === 0 && !hasFlag(flags, 'allow-empty')) {
    return {
      ok: false, action: 'reconcile-active', repoKey,
      error: 'reconcile-active requires a non-empty --active <id,...> set (pass --allow-empty to archive ALL current workspaces)',
    };
  }

  const activeMatches = (id) => {
    for (const t of activeTokens) {
      if (!t) continue;
      if (id === t) return true;
      if (t.length >= 4 && id.startsWith(t)) return true; // short prefix (roster/8-hex spelling)
      if (t.length >= 8 && id.includes(t)) return true;    // 8-hex embedded in primary-<hex>
    }
    return false;
  };

  const candidates = [];
  const kept = [];
  for (const d of projectScopedDescriptors(home, repoKey)) {
    if (activeMatches(d.id)) { kept.push(d.id); continue; }
    candidates.push({ id: d.id, worktreePath: d.worktreePath });
  }

  if (!confirm) {
    return {
      ok: true, action: 'reconcile-active', repoKey, dryRun: true,
      active: activeTokens, kept, count: candidates.length, candidates,
      note: 'dry-run: pass --yes (or --confirm) to archive these workspaces',
    };
  }
  const archived = [];
  for (const c of candidates) {
    const r = cmdArchive(c.id, ctx);
    archived.push({ id: c.id, ok: !!r.ok, error: r.error || null });
  }
  return {
    ok: archived.every((a) => a.ok), action: 'reconcile-active', repoKey, dryRun: false,
    active: activeTokens, kept, count: archived.length, archived,
  };
}

// resolveCreatedWorktreePath(res) -> string | null. TOLERANT best-effort parse
// of `hivecontrol workspace create`'s stdout for a `path`/`worktreePath` field
// (accepting a top-level field or one nested under a `workspace` key) — the
// exact JSON shape is not pinned in the KB, so this NEVER guesses a directory-
// naming convention; an unparseable/fieldless payload returns null, and the
// caller treats that as a legitimate best-effort-skip, not an error.
function resolveCreatedWorktreePath(res) {
  if (!res || typeof res.raw !== 'string') return null;
  try {
    const parsed = JSON.parse(res.raw);
    if (parsed && typeof parsed === 'object') {
      const nested = parsed.workspace && typeof parsed.workspace === 'object' ? parsed.workspace : null;
      const p = parsed.path || parsed.worktreePath || (nested && (nested.path || nested.worktreePath));
      if (typeof p === 'string' && p) return p;
    }
  } catch (_) { /* unparseable -> null, never a guess */ }
  return null;
}

// ---- Task #6 (workspace naming) helpers ------------------------------------
//
// hasSpawnFlag(rest, shortFlag, longFlag) -> bool. TOLERANT scan for either
// commander-style spacing form (`--title value` / `--title=value` /
// `-t value`) — `rest` is forwarded VERBATIM to hivecontrol (never re-parsed
// elsewhere in this file, per cmdSpawn's own long-standing contract), so this
// scan must recognize the same forms hivecontrol's own parser accepts, or a
// caller-supplied -t could be missed and DOUBLE-injected below.
// NAMED DISTINCTLY from the pre-existing hasFlag(flags, name) (line ~2911,
// used everywhere in this file for `--yes`/`--confirm`-style CLI flags): two
// top-level `function hasFlag` declarations in the same scope would silently
// let the SECOND one win at every call site (JS function redeclaration, not
// an overload) — caught live via `reconcile-active --yes` losing its confirm
// detection during this change's own verification pass.
function hasSpawnFlag(rest, shortFlag, longFlag) {
  if (!Array.isArray(rest)) return false;
  return rest.some((a) => typeof a === 'string' &&
    (a === shortFlag || a === longFlag || a.indexOf(longFlag + '=') === 0));
}

// extractFlagValue(rest, shortFlag, longFlag) -> string | null. Same tolerant
// forms as hasSpawnFlag; returns the FIRST match's value (the next argv
// element for the space form, or the substring after `=` for the equals
// form). No pre-existing extractFlagValue in this file (verified) — no
// collision risk here.
function extractFlagValue(rest, shortFlag, longFlag) {
  if (!Array.isArray(rest)) return null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (typeof a !== 'string') continue;
    if (a === shortFlag || a === longFlag) {
      return (typeof rest[i + 1] === 'string') ? rest[i + 1] : null;
    }
    if (a.indexOf(longFlag + '=') === 0) return a.slice(longFlag.length + 1);
  }
  return null;
}

// deriveTitleFromBrief(brief) -> string | null. Owner-approved derivation
// rule: take the first non-empty line of the brief, strip ONE leading
// markdown marker (heading/bullet/quote) so a line like "# own the API layer"
// titles as "own the API layer" rather than carrying the marker, collapse
// internal whitespace, then truncate to 60 chars on a WORD boundary with a
// trailing ellipsis if cut. Returns null for a non-string/empty/blank brief.
function deriveTitleFromBrief(brief) {
  if (typeof brief !== 'string') return null;
  let line = null;
  for (const l of brief.split(/\r?\n/)) {
    const t = l.trim();
    if (t) { line = t; break; }
  }
  if (!line) return null;
  line = line.replace(/^(#{1,6}|[-*>])\s+/, '').trim().replace(/\s+/g, ' ');
  if (!line) return null;
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  const boundary = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return boundary + '…';
}

// cmdSpawn(rest, ctx) — PLAN.md "spawn": THIN pass-through wrap of
// `hivecontrol workspace create <branch> ...` (rest[0] is the branch; every
// remaining token forwards untouched — never re-implemented, never gated;
// hivecontrol may add create flags without anti-hall ever changing), then a
// best-effort auto-registration of the new worktree in THIS project's shared
// store registry (store-only — no descriptor file, no sessionId yet; the
// child's own first inbox-pull/heartbeat/register fills that in itself, the
// same self-registration path every other child already relies on). A create
// failure is returned as-is; a registration failure AFTER a successful create
// never rolls back or fails the (already-succeeded) hivecontrol create.
//
// Task #6 naming (CORRECTED design, owner 2026-07-27): a title is set via a
// SEPARATE follow-up `hivecontrol workspace update-title -b <branch> <title>`
// call — NEVER by touching the argv forwarded to `create` above. An earlier
// draft injected `-t` into that forwarded array and broke the "THIN
// pass-through... untouched, including short flags" invariant this file's
// own tests enforce (and the very next test: "spawn never re-parses or gates
// hivecontrol's own flags"). update-title also targets ANY existing branch
// via -b, which -t-at-create never could — so cmdReconcile's read-only name
// backfill (below) can mirror an already-set title into the local cache for
// a PRE-EXISTING workspace too, off the hot path; it deliberately does NOT
// fabricate/apply a title to hivecontrol for a workspace with no brief on
// record (no ungrounded write into a user-facing GUI label).
//
// Fires ONLY when the caller did NOT pass -t/--title AND DID pass
// -p/--prompt (derivation: deriveTitleFromBrief). Gated on the SAME
// worktreePath-resolved condition as registration below (a create response
// we cannot resolve a path from is not confirmed enough to act further on —
// same conservative posture registration already uses). FAIL-OPEN: an
// update-title failure/exception NEVER fails the spawn verb (mirrors
// registration's own best-effort-skip posture — `registered:false`/
// `titled:false` are legitimate reported outcomes, never verb failures).
function cmdSpawn(rest, ctx) {
  const branch = rest && rest[0];
  if (!branch) return { ok: false, error: 'spawn requires a branch name' };
  const cwd = ctx.cwd || process.cwd();
  const run = (ctx.io && ctx.io.run) || pull.defaultRun;
  const args = ['workspace', 'create'].concat(rest);
  const res = run({ args, env: ctx.env, cwd });
  if (!res || !res.ok) {
    return { ok: false, error: (res && res.error) || 'hivecontrol workspace create failed', branch };
  }

  // Title derivation is pure/no I/O — computed up front, but the actual
  // update-title CALL only fires inside the worktreePath-resolved branch
  // below (see doc comment above for why).
  let derivedTitle = null;
  if (!hasSpawnFlag(rest, '-t', '--title')) {
    derivedTitle = deriveTitleFromBrief(extractFlagValue(rest, '-p', '--prompt'));
  }

  let registered = false;
  let titled = false;
  let worktreePath = null;
  let meshId = null;
  try {
    // hivecontrol's own `create` output shape is NOT pinned in the KB, so this
    // is a TOLERANT best-effort parse (same posture as this file's own
    // parseChildrenList) for a `path`/`worktreePath` field — NEVER a guessed
    // directory-naming convention. `ctx.io.newWorktreePath` is the explicit
    // test/override seam. Absent a resolvable path, registration (and the
    // title follow-up) is best-effort-skipped (`registered:false`/
    // `titled:false` are legitimate reported outcomes — never a failure of
    // the verb itself, which already succeeded at the create call above).
    worktreePath = (ctx.io && ctx.io.newWorktreePath) || resolveCreatedWorktreePath(res);
    if (worktreePath) {
      meshId = inst.primaryWorkspaceId(worktreePath);
      const repoKey = repoKeyForCwd(ctx);
      const s = store.openStore({ home: ctx.home, hash: repoKey || undefined, backend: ctx.backend, env: ctx.env });
      try {
        // No per-id lock here (verified race-free, NOT an oversight): `meshId` is
        // derived from a worktreePath `hivecontrol workspace create` JUST minted
        // above — a brand-new id no other process has seen yet. This is a blind
        // SEED insert (all descriptor fields null), not a read-modify-write, so
        // there is no snapshot to lose. No concurrent writer can touch this id at
        // this instant: a second `spawn` of the same branch fails at the `create`
        // call above (worktree already exists) and never reaches here, and the
        // workspace's own child cannot `register` until it is launched in the
        // freshly-created worktree — strictly AFTER this call returns. That later
        // child register runs under withIdLock and upserts its real inbox over this
        // placeholder; the two are ordered, never interleaved. A lock would guard
        // nothing (see rekeySubdirRegistryRows for a case that genuinely needs one).
        s.upsertRegistry({ id: meshId, worktreePath, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null });
        store.deriveSummary(s, { home: ctx.home, env: ctx.env, now: ctx.now });
        registered = true;
      } finally { s.close(); }

      // Title follow-up (task #6, corrected design): a SEPARATE hivecontrol
      // call, entirely independent of the `create` argv above. Best-effort —
      // never re-throws into the caller, never fails the spawn verb.
      if (derivedTitle) {
        try {
          const tres = run({ args: ['workspace', 'update-title', '-b', branch, derivedTitle], env: ctx.env, cwd });
          titled = !!(tres && tres.ok);
        } catch (_) { titled = false; }
        // Cache ONLY when hivecontrol actually confirmed the title — never
        // cache a name we don't know was really applied (the local cache
        // must stay a mirror of real state, not a hopeful guess).
        if (titled) { try { names.writeName(ctx.home, meshId, derivedTitle, ctx.now); } catch (_) { /* best-effort */ } }
      }
    }
  } catch (_) { registered = false; }

  return {
    ok: true, action: 'spawn', branch, created: true,
    worktreePath, meshId, registered, titled, raw: res.raw,
  };
}

// cmdMergeVerb(rest, ctx) — PLAN.md "merge": THIN wrap of `hivecontrol
// workspace check-merge` (informational, always run first) + `hivecontrol
// workspace merge-into-source ...` (the documented "ship upstream" completion
// step — the standard child-finish flow this verb is named for; the OTHER
// direction, `merge-from-source`, stays a raw hivecontrol call, never
// blocked). `rest` forwards to merge-into-source untouched (pass-through —
// this verb never re-parses or gates on check-merge's own verdict; hivecontrol's
// own merge call reports its own success/failure faithfully). The outcome is
// then `send --broadcast` to the mesh so every peer sees a merge landed
// without needing to poll — best-effort: a broadcast failure (e.g. non-git
// cwd) never masks the merge's own result.
function cmdMergeVerb(rest, ctx) {
  const cwd = ctx.cwd || process.cwd();
  const run = (ctx.io && ctx.io.run) || pull.defaultRun;

  const checkRes = run({ args: ['workspace', 'check-merge'], env: ctx.env, cwd });
  let checkMerge = null;
  if (checkRes && checkRes.ok) {
    try { checkMerge = JSON.parse(checkRes.raw); } catch (_) { checkMerge = null; }
  }

  const mergeArgs = ['workspace', 'merge-into-source'].concat(rest || []);
  const mergeRes = run({ args: mergeArgs, env: ctx.env, cwd });
  const merged = !!(mergeRes && mergeRes.ok);

  let broadcast = null;
  try {
    const repoKey = repokey.repoKeyForWorktree(cwd);
    if (!repoKey) {
      broadcast = { ok: false, reason: 'no-project' };
    } else {
      const from = callerIdentity(ctx.env, cwd);
      const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
      const summary = merged
        ? 'merge-into-source completed'
        : 'merge-into-source failed: ' + ((mergeRes && mergeRes.error) || 'unknown error');
      const s = store.openStore({ home: ctx.home, hash: repoKey, backend: ctx.backend, env: ctx.env });
      try {
        const fields = { from, to: null, type: 'broadcast', message: summary, timestamp: now, urgency: merged ? 'normal' : 'high' };
        const hash = store.meshMessageHash(fields);
        const bres = store.appendMeshMessage(s, Object.assign({}, fields, { hash }));
        store.deriveSummary(s, { home: ctx.home, env: ctx.env, now });
        broadcast = { ok: true, sent: !!bres.inserted, seq: bres.seq };
      } finally { s.close(); }
    }
  } catch (e) {
    broadcast = { ok: false, error: String(e && e.message || e) };
  }

  return {
    ok: merged, action: 'merge', checkMerge, merged,
    error: merged ? undefined : ((mergeRes && mergeRes.error) || 'merge-into-source failed'),
    raw: mergeRes && mergeRes.raw, broadcast,
  };
}

// parseSinceDuration(raw) -> milliseconds | null. Accepts a bare number (ms) or
// a <number><unit> duration with unit ms/s/m/h/d (e.g. '30m', '2h', '1d'). null
// on an unparseable value — the caller then omits the `since` filter (fail-open).
function parseSinceDuration(raw) {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (str === '') return null;
  const m = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] || 'ms').toLowerCase();
  const mult = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : unit === 'm' ? 60000 : unit === 's' ? 1000 : 1;
  return n * mult;
}

// cmdLogs(flags, ctx) — read the central DevSwarm JSONL log via the shared
// logger's readRecent() and return a concise, filterable summary so a Primary
// can analyze a child project's recent errors/events FROM HERE (the logger is a
// single central stream across every project, so one call spans them all).
// Filters: --repo <repoKey>, --component <name>, --min-level
// debug|info|warn|error, --since <dur> (e.g. 30m / 2h / 1d, or bare ms),
// --limit N (default 50, newest-last). READ-ONLY: never writes, never throws.
function cmdLogs(flags, ctx) {
  const opts = {};
  const repo = one(flags, 'repo');
  if (repo !== undefined) opts.repoKey = repo;
  const component = one(flags, 'component');
  if (component !== undefined) opts.component = component;
  const minLevel = one(flags, 'min-level');
  if (minLevel !== undefined) opts.minLevel = minLevel;
  const sinceMs = parseSinceDuration(one(flags, 'since'));
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  if (sinceMs != null) opts.sinceMs = now - sinceMs;
  let limit = 50;
  const limitRaw = one(flags, 'limit');
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (Number.isFinite(n) && n >= 0) limit = Math.floor(n);
  }
  opts.limit = limit;
  let entries = [];
  try { entries = alog.readRecent(opts) || []; } catch (_) { entries = []; }
  // Concise rollups a Primary actually wants over the returned slice.
  const byComponent = {};
  const byLevel = {};
  for (const e of entries) {
    if (!e) continue;
    const c = e.component != null ? String(e.component) : '(none)';
    byComponent[c] = (byComponent[c] || 0) + 1;
    const lv = e.level != null ? String(e.level) : '(none)';
    byLevel[lv] = (byLevel[lv] || 0) + 1;
  }
  let logFile = null;
  try { logFile = alog.logFilePath(); } catch (_) { logFile = null; }
  return {
    ok: true, action: 'logs', logFile,
    filters: {
      repoKey: opts.repoKey != null ? opts.repoKey : null,
      component: opts.component != null ? opts.component : null,
      minLevel: opts.minLevel != null ? opts.minLevel : null,
      sinceMs: opts.sinceMs != null ? opts.sinceMs : null,
      limit,
    },
    count: entries.length,
    byComponent, byLevel,
    entries,
  };
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

// run(argv, ctx) -> { code, result }. ctx: { home, env, backend, now } (all
// injectable for tests). NEVER throws — any internal error becomes a
// { ok:false, error } result with exit code 2.
function run(argv, ctx0) {
  const ctx = Object.assign({ home: os.homedir(), env: process.env }, ctx0 || {});
  const { positionals, flags } = parseArgs(argv || []);
  const cmd = positionals[0];
  try {
    switch (cmd) {
      case 'register': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const r = cmdRegister(id, flags, ctx);
        logVerbOutcome('register', id, r, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'ensure': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const r = cmdRegister(id, flags, ctx, { requireNew: true });
        logVerbOutcome('ensure', id, r, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'heartbeat': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const r = cmdHeartbeat(id, flags, ctx);
        // A5(b)/(d) + P1 fix: the exit code derives from `r.ok` (every other
        // verb already does this) instead of a hardcoded 0. This is NO LONGER
        // a no-op: cmdHeartbeat's own top-level `ok` now folds in a HARD
        // meshBroadcast failure (e.g. an invalid --urgency value) — see
        // BENIGN_MESH_BROADCAST_REASONS + cmdHeartbeat's own return statement
        // for the exact, deliberately-narrow escalation rule. The two
        // documented/tested benign shapes (no-project dormancy, ownership-
        // refusal-as-security-control — devswarm-send.test.js's "forged"/
        // "no-project" cases) still keep `ok:true` alongside an explicit
        // `meshBroadcast.ok:false`, unchanged, so a caller that cares about
        // JUST the broadcast outcome can still check `meshBroadcast.ok`
        // directly. A broadcast-specific refusal/failure — previously
        // invisible to `devswarm logs` entirely — is surfaced there too.
        if (r && r.meshBroadcast && r.meshBroadcast.ok === false) {
          logVerbOutcome('heartbeat-broadcast', id, r.meshBroadcast, ctx);
        }
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'inbox': {
        const sub = positionals[1];
        const id = positionals[2];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        // 'pull' is the NATIVE-DRAIN verb (Phase 7 send-time self-heal, D-O-D7):
        // self-heal runs BEFORE it, never before the other (non-draining) inbox
        // subcommands (count/read/ack/messages).
        const r = sub === 'pull'
          ? withSelfHeal(() => cmdInbox(sub, id, flags, ctx), ctx)
          : cmdInbox(sub, id, flags, ctx);
        // Csh: wire only the mesh READ verbs the task names (pull/messages/
        // read-primary); count/read/ack are the descriptor durable-inbox path.
        if (sub === 'pull' || sub === 'messages' || sub === 'read-primary') {
          logVerbOutcome('inbox-' + sub, id, r, ctx);
        }
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'workspaces': {
        const sub = positionals[1] || 'list';
        if (sub !== 'list') return { code: 2, result: { ok: false, error: 'unknown workspaces subcommand: ' + sub } };
        return { code: 0, result: cmdWorkspacesList(flags, ctx) };
      }
      case 'gate': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const r = cmdGate(id, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'nudge': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const r = cmdNudge(id, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'archive': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const r = cmdArchive(id, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'unarchive': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const r = cmdUnarchive(id, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'archive-ignore': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        return { code: 0, result: cmdArchiveIgnore(id, ctx, { set: true }) };
      }
      case 'archive-unignore': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        return { code: 0, result: cmdArchiveIgnore(id, ctx, { set: false }) };
      }
      case 'archive-request': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        // Send-time self-heal (Phase 7): archive-request is a mesh-direct STORE
        // write (v0.58) — still a "send-like verb" per withSelfHeal's own
        // categorization, so the per-project ingest daemon health check still runs.
        const r = withSelfHeal(() => cmdArchiveRequest(id, flags, ctx), ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'register-primary': {
        const r = cmdRegisterPrimary(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'migrate': {
        // A5(b): exit code now reflects `ok` (migrateToStore genuinely returns
        // ok:false on lock contention) instead of a hardcoded 0.
        const r = cmdMigrate(ctx);
        return { code: r && r.ok ? 0 : 2, result: r };
      }
      case 'logs': {
        // READ-ONLY central-log analysis (Csh). Filterable summary of the shared
        // JSONL error/event stream so a Primary can triage a child's failures.
        // A5(b): derives from `ok` for dispatcher consistency (cmdLogs is a
        // pure read that never itself fails, so this is a no-op today).
        const r = cmdLogs(flags, ctx);
        return { code: r && r.ok ? 0 : 2, result: r };
      }
      case 'migrate-owner-keys': {
        // P1-8 forward-migration (idempotent, fail-open, no-delete). Exposed as a
        // verb so update/doctor/an operator can run it directly.
        // A5(b): exit code now reflects `ok` (migrateOwnerKeys sets ok:false
        // when any descriptor failed to migrate) instead of a hardcoded 0.
        const r = migrateOwnerKeys(ctx.home, ctx);
        return { code: r && r.ok ? 0 : 2, result: r };
      }
      case 'send': {
        // Send-time self-heal (Phase 7): runs before every mesh send.
        const r = withSelfHeal(() => cmdSend(flags, ctx), ctx);
        logVerbOutcome('send', one(flags, 'to'), r, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'roster': {
        // `roster --ack` is an alias of `mesh read` (D23) — both clear the
        // caller's own broadcastUnread; plain `roster` is a read-only projection.
        const r = hasFlag(flags, 'ack') ? cmdMeshRead(flags, ctx) : cmdRoster(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'diagnose': {
        // READ-ONLY mesh-health projection (#62) — pure, never writes summary.json.
        const r = cmdDiagnose(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'healthcheck': {
        // #71: pass/fail gate over the SAME data diagnose computes — pure read,
        // exit 0 = healthy, non-zero = degraded (for monitors/CI/daemon).
        const r = cmdHealthcheck(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'mesh': {
        const sub = positionals[1];
        if (sub === 'read') {
          const r = cmdMeshRead(flags, ctx);
          return { code: r.ok ? 0 : 2, result: r };
        }
        return { code: 2, result: { ok: false, error: 'unknown mesh subcommand: ' + JSON.stringify(sub || '') + ' (read)' } };
      }
      case 'reconcile': {
        const r = cmdReconcile(flags, ctx);
        logVerbOutcome('reconcile', null, r, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'reap-stale': {
        const r = cmdReapStale(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'reconcile-active': {
        const r = cmdReconcileActive(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'spawn': {
        // THIN pass-through (PLAN.md): the RAW argv tail (never our own `--long`
        // flag parser, which would swallow a `--prompt`/`--title`/etc. token and
        // break faithful forwarding) — argv[0] is 'spawn' itself.
        const r = cmdSpawn((argv || []).slice(1), ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'merge': {
        // THIN pass-through (PLAN.md), same raw-tail posture as `spawn`.
        const r = cmdMergeVerb((argv || []).slice(1), ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'skip': {
        // The escape-hatch CLI entry point: `skip <guard> [--ttl <minutes>]`.
        // No isSafeId gate here — guard names ("edit-guard", "all", ...) are a
        // fixed, code-defined vocabulary read back by skip-guard.js's own
        // isSkipped(), not a filesystem id.
        const guard = positionals[1];
        if (!guard) {
          return { code: 2, result: { ok: false, error: 'usage: devswarm.js skip <guard> [--ttl <minutes>]' } };
        }
        const r = cmdSkip(guard, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      default:
        return { code: 2, result: { ok: false, error: 'unknown command: ' + JSON.stringify(cmd || '') +
          ' (register|register-primary|ensure|heartbeat|inbox|workspaces|gate|nudge|archive|unarchive|archive-ignore|archive-unignore|archive-request|migrate|migrate-owner-keys|logs|send|roster|diagnose|healthcheck|mesh|reconcile|reap-stale|reconcile-active|spawn|merge|skip)' } };
    }
  } catch (e) {
    // Csh: an internal exception used to be swallowed silently into { ok:false }.
    // Log it (fail-open, control flow unchanged) so a Primary can surface it via
    // `devswarm logs`. Best-effort repoKey from cwd; op = the verb that threw.
    try {
      let repoKey = null;
      try { repoKey = repoKeyForCwd(ctx); } catch (_) { repoKey = null; }
      alog.logError('devswarm-cli', String(cmd || 'unknown'), e, { repoKey });
    } catch (_) { /* logging must never mask the original error */ }
    return { code: 2, result: { ok: false, error: String(e && e.message || e) } };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const { code, result } = run(argv);
  // `healthcheck` (no --json) prints ONE compact human line; every other verb —
  // and `healthcheck --json` — prints the raw JSON object. This is the only verb
  // with a human-line mode (there is no prior --json/--human precedent in this CLI).
  const wantHuman = argv[0] === 'healthcheck' && !argv.includes('--json');
  const out = wantHuman ? healthcheckHumanLine(result) : JSON.stringify(result);
  // fs.writeSync(1, ...) per repo rule (macOS node 18/20 exit-vs-async-flush race).
  fs.writeSync(1, out + '\n');
  process.exit(code);
}

if (require.main === module) {
  main();
}

module.exports = {
  run, parseArgs, one, many, csvList,
  buildDescriptorFromFlags, readDescriptorFile, descriptorPath,
  retireWorktreeDuplicates,
  foldGroupIntoSurvivor, canonicalMeshId, canonicalWorktreeRealPath, groupRegistryByMeshId, foldMeshDuplicates,
  retireArchivedWorktreeGroup, foldArchivedRegistryRows, meshRowCopy, MESH_ROW_COPY_FIELDS, cmdRoster,
  computeDiagnosis, healthcheckHumanLine,
  resolveMeshTarget, resolveSendTarget,
  workspacesDir, archivedDir, heartbeatsDir, archiveIgnoreDir, primaryCursorPath, skipFilePath,
  selfHeal, withSelfHeal, SELF_HEAL_COOLDOWN_MS, selfHealCooldownPath,
  migrateOwnerKeys, rehomeCore, rehomeAcrossStores, rehomeMiskeyedRow, healRegistry, withIdLock, cmdArchive, archivedTombstoneIsOrphaned,
  applyRecoveryIntents, recoveryIntentPath, rehomeStrandedProjectDescriptors,
  cmdWorkspacesList, cmdGate, cmdReconcile, cmdRegister,
  cmdLogs, cmdInboxMessages, parseSinceDuration,
  descriptorFreshRepoKey, descriptorStructuralRepoKey,
};
