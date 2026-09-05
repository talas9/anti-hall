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
//                  the durable-inbox cursor primitive (advance = ack-all). B4:
//                  each returned message row carries BOTH `seq` (the durable,
//                  store-wide physical id — the SAME value `send`'s own `seq`
//                  returns; safe to compare across calls) and `index` (a
//                  PAGE-LOCAL positional ordinal within THIS call's result, and
//                  the unit `--to N`/the ack cursor actually advances in —
//                  never compare `index` across calls). Prefer `hash`
//                  (table-wide UNIQUE) over either when verifying a specific
//                  message.
//   inbox messages <id> [--limit N] [--since <index>|<ISO date>] [--tail N]
//                  NON-ACKING read of a partition's rows (earliest-first). --since
//                  and --tail bound it to recent mail WITHOUT the destructive
//                  read-primary path (defect 3f6027ee462a). Both are REJECTED on
//                  every ack-bearing verb (`inbox read/ack/count`, `read-primary`,
//                  `peek-primary`, `inbox messages --ack`) — a window is not a
//                  contiguous prefix, and this file's ack arithmetic can only
//                  express a prefix. Rejected loudly, never silently ignored.
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
//                  --force-cross-project <id>: the ONE escape hatch past the
//                  id-derived authority gate, accepted only when its value equals
//                  the id exactly, and logged to logs/devswarm-authority-override.log.
//                  Archive ONLY — never ensure/ack/gate (see KB §35).
//   reap-orphans [--apply --max N] [--i-am-a-human]
//                  retire mesh partitions that hold unread mail with NO live reader
//                  (the same set the per-turn ORPHANED MESH warning reports, read
//                  from computeSummary, not re-derived). DRY RUN BY DEFAULT. --apply
//                  requires --max N; refuses under ANTIHALL_DEVSWARM_AUTOMATION=1 or
//                  a non-TTY stdin without --i-am-a-human. Each partition's unread
//                  rows are archived to reaped/<id>.ndjson and VERIFIED before its
//                  cursor is advanced; no message row is ever deleted (KB §33).
//   reconcile-registry
//                  REPORT-ONLY drift between the mesh registry and `hivecontrol
//                  workspace list all`, both directions + worktreePath mismatches.
//                  Never mutates. Pins the upstream JSON shape and fails soft with
//                  `hivecontrol-shape-unrecognized` rather than guessing (KB §34).
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
//                  (D28 — never emits an env-derived `from`). B4: the returned
//                  `seq` is the durable, store-wide physical id — compare it
//                  across calls, and against `inbox messages`/`inbox count/read`'s
//                  own `seq` field, freely. It is NOT the same thing as `index`
//                  (see `inbox count/read/ack` below) — never compare `seq` to an
//                  `index`. For verifying a specific message landed, match on
//                  `hash` instead (table-wide UNIQUE).
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
const livenessSelect = require('../companion/lib/devswarm-liveness-select.js');
const inboxCursor = require('../companion/lib/devswarm-inbox-cursor.js');
const devswarmUnread = require('../companion/lib/devswarm-unread.js');
const { isArchivedWorkspace } = require('../companion/lib/devswarm-archived.js');
// APP-SIDE archive cache (read side; the WRITE side is the supervisor sweep,
// fed by fetchActiveWorkspaceRecords below). Leaf module — no cycle.
const archivedCacheLib = require('../companion/lib/devswarm-archived-cache.js');
const {
  isSafeId, devswarmRoot, livenessPathFor,
  writeVerdict, hasFreshHeartbeat, heartbeatTs, worktreeActivityMtime, unreadBacklog, DEFAULT_IDLE_MS,
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
const gitTruth = require('../companion/lib/devswarm-git-truth.js');
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
// row's `sessionId` used to be the ONLY liveness signal every mesh-addressing/
// fold primitive in this file read for ROUTING/FOLD decisions (resolveMeshTarget,
// pickSurvivor, groupRegistryByMeshId's liveRows) — a bare "non-empty,
// non-synthetic sessionId" shape test, with no heartbeat/dormancy correlation.
// D11-A (f56dcc08f048) MOVED those three onto isRoutingLiveRow (below —
// composes companion/lib/liveness.js's isSiblingPartitionLive, the SAME
// heartbeat-freshness + harness-session-dormancy predicate siblingAckGate
// (:367) and the fold's own mesh-anchor check (~:2520) already use, plus a
// descriptor-existence fallback for a just-registered row with no heartbeat
// yet), so a real-but-long-dead sessionId (e.g. a crashed sibling whose
// registry row was never cleaned up) can no longer be routed/folded to as
// "live" the way computeDiagnosis's `rows[].live` display field already
// stopped trusting it. rehomeMiskeyedRow's identity confirmation is a
// DIFFERENT question (same-entity confirmation, not a drain/routing
// decision) and deliberately keeps the bare isLiveSessionId shape test — see
// that function's own comment for why. This predicate (isLiveSessionId)
// remains the raw shape test other non-routing call sites in this file still
// use directly (pickArchiveForwardSurvivor, archiveLeftReason, etc — out of
// scope for this migration). Historical note: a non-empty sessionId alone was
// never proof a session was still running — closing a workspace never
// deletes its registry row, so a once-real sessionId was trusted forever
// unless something aged it out. cmdInboxPull's auto-ensure/self-register path
// used to MINT a sessionId from `id` itself when neither `--session` nor
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

// isRoutingLiveRowStrict(row, home, opts) -> bool. D11-A (f56dcc08f048): the
// STRICT liveness gate for a TARGET-SELECTION decision — resolveMeshTarget/
// pickSurvivor's pickFreshestLive candidate filter — where the question is
// "will THIS row actually drain what gets routed to it". A bare
// isSiblingPartitionLive call (companion/lib/liveness.js — the SAME
// heartbeat-freshness + harness-session-dormancy predicate siblingAckGate
// (:367 in this file) and the fold's own mesh-anchor check (~:2520) already
// use), with NO descriptor-existence fallback: CONFIRMED regression (see
// tests/scripts/devswarm-fold-forwarded-derive.test.js) that adding one here
// lets a store-only, sessionId:null row with a merely-lingering descriptor
// file outrank a GENUINELY live sibling purely on `updatedAt` recency inside
// pickFreshestLive's ranking — the exact "descriptor proves only that a
// workspace once existed, never that anything will drain it" hazard
// pickArchiveForwardSurvivor's own header already documents (STRICT vs
// CONSERVATIVE, ~:2794): a descriptor-existence fallback is the right,
// conservative answer for "should this row be protected from tombstoning"
// (isRoutingLiveRow below, for groupRegistryByMeshId's REPORTING-only
// liveRows counter) and the wrong, unsafe answer for "which row should be
// treated as authoritative" (this function, for actual send/fold routing).
// Fail-open: any throw -> not live (undetermined never wins a selection).
function isRoutingLiveRowStrict(row, home, opts) {
  if (!row || row.id == null) return false;
  try {
    return !!isSiblingPartitionLive({ id: row.id, worktreePath: row.worktreePath, sessionId: row.sessionId }, home, opts);
  } catch (_) { return false; }
}

// isRoutingLiveRow(row, home, opts) -> bool. D11-A (f56dcc08f048): the shared
// liveness gate for groupRegistryByMeshId's `liveRows` — a REPORTING-only
// counter (computeDiagnosis's meshTargets kind/split/deadSplit; it does not
// itself pick a fold/send target — see isRoutingLiveRowStrict above for that,
// STRICTER, decision) — replacing the bare isLiveSessionId(sessionId) shape
// test that counter used to read directly (see the header above, now
// updated). Composes isSiblingPartitionLive with a descriptor-existence
// fallback, mirroring the fold's own `live || readDescriptorFile(...) ||
// readerEvidence` composition (~:2525): a row that has JUST been `register`ed
// (a synthetic `unclaimed:` sessionId, no heartbeat file written yet) reads
// NOT live from isSiblingPartitionLive alone (its register-only-phantom
// branch) even though it is not actually dead — its descriptor
// (workspaces/<id>.json, written by register before/alongside the registry
// upsert) already exists, which is the same "something observable exists"
// signal the fold falls back to. `readerEvidence` (the fold's cursor-based
// third term) is intentionally NOT reproduced here — it needs an open store
// handle + cursor read the fold already holds at its call site that this
// counter does not carry the same way; descriptor existence is the evidence
// it can uniformly check instead.
// Fail-open: any throw from either half leaves the row NOT live only when
// BOTH checks fail; never disqualifies on a partial failure.
function isRoutingLiveRow(row, home, opts) {
  if (!row || row.id == null) return false;
  try {
    if (isSiblingPartitionLive({ id: row.id, worktreePath: row.worktreePath, sessionId: row.sessionId }, home, opts)) return true;
  } catch (_) { /* fall through to descriptor fallback */ }
  try { return !!readDescriptorFile(home, row.id); } catch (_) { return false; }
}

// siblingAckGate(storeHandle, callerId, partId, home, now) -> bool (true ==
// LIVE or SELF, skip the ack). Fix Wave 7 Item 1 + Item 2: the ONE
// mesh-sibling cursor-write gate, used by BOTH `cmdInboxMessages`'s
// read-primary/peek-primary ack loop AND `inbox ack`'s own separate
// sibling-store-cursor loop — Wave 6 gated only the former
// (`hasFreshHeartbeat(part.id, home, {now})` inline), leaving `inbox ack`
// (and `--ack-as-owner`) free to drive a live sibling's cursor forward and
// consume its backlog undelivered (reproduced, P0). Factoring this into ONE
// function callable from both sites is what makes a future THIRD surface
// structurally unable to add itself ungated (call this, or diverge visibly in
// review — there is no longer an inline copy to half-port).
//
// Looks up `partId`'s OWN registry row (worktreePath/sessionId) — the
// liveness composition (`isSiblingPartitionLive`, companion/lib/liveness.js)
// needs both, not just the id, to tell a positively-stale real session apart
// from a register-only phantom. A registry-read failure or a row that has
// vanished from `listRegistry()` between the fold and this check is
// UNDETERMINED, not evidence of anything — fails toward LIVE (skip the ack)
// for the same reason `isSiblingPartitionLive` itself fails open: a spurious
// skip only risks a harmless re-delivery, a spurious ack risks permanently
// losing a live sibling's own unread backlog.
//
// IDENTITY-FAMILY EXTENSION (confirmed gap, root-cause trace): the checks
// above evaluate `partId`'s OWN row/heartbeat only — a UUID twin row of the
// SAME agent (crossLinkedIdentity: one row's sessionId IS the other row's
// id — devswarm-identity-family.js) never heartbeats under its own id (only
// its `primary-<hash>` twin does), so it read as NOT live and was drained +
// acked by the sibling loops during the CALLER's own read even when the
// caller and the twin are the SAME agent. Two additional checks, reusing
// devswarm-identity-family.js's crossLinkedIdentity/identityFamilyTwins
// (never a second family notion):
//   (1) SELF: if `partId`'s row is a cross-linked twin of the CALLER's own
//       row, this is not a "sibling" at all — it is the caller's own other
//       identity. WAVE 9 CORRECTION (P1): this branch used to `return true`
//       (skip the ack) on the theory that "the caller's own read/ack path
//       (cursorPath / s.setCursor for callerId) already governs it". That
//       theory is FALSE and caused PERPETUAL RE-DELIVERY. The own-store ack
//       writes exactly two cursors, BOTH keyed on the caller's own id
//       (`inboxCursor.ackTo(cursorPath, ownTarget)` and `s.setCursor(id,
//       acked)`); the twin partition's own cursor pair
//       (`primaryCursorPath(home, twinId)` / `s.setCursor(twinId, …)`) is
//       touched by nothing on this read. Meanwhile the twin's rows ARE folded
//       into `messages` and delivered on EVERY call (the sibling partitions
//       are built before this gate; the gate governs the cursor WRITE only) —
//       so the same rows came back forever and the twin's cursor never moved.
//       A SELF twin is therefore NOT protected here: it returns false so the
//       caller's sibling loop acks it with the SAME ack-target arithmetic
//       every other partition uses (`part.cursor + physicalConsumed`, derived
//       from rows ACTUALLY delivered — loss-free by that same construction,
//       so nothing withheld by a cap can ever be skipped over). This is safe
//       precisely BECAUSE it is SELF: crossLinkedIdentity proves the twin is
//       the caller's own identity, so there is no other reader whose frontier
//       could be swept. Foreign siblings (live, or twin-of-live below) keep
//       their full protection — the gate is not widened for anyone else.
//   (2) TWIN-OF-LIVE: if `partId` itself reads as not-live, but ANY other
//       registry row is a cross-linked twin of `partId` AND that twin reads
//       as live, then `partId` is live (its twin identity is the one
//       actually heartbeating) — return true (skip).
// Any resolution failure (require/registry-read throwing) falls through to
// the pre-existing bare liveness check, never a hard failure — this
// extension can only make the gate MORE conservative (skip more), never
// less (it never turns an existing "live" result into "not live").
function siblingAckGate(storeHandle, callerId, partId, home, now) {
  let idFam = null;
  try { idFam = require('../companion/lib/devswarm-identity-family.js'); } catch (_) { idFam = null; }
  let registry = [];
  try { registry = storeHandle.listRegistry() || []; } catch (_) { registry = []; }
  const row = registry.find((r) => r && String(r.id) === String(partId));
  if (!row) return true; // vanished from the registry read -> undetermined -> fail toward live
  if (idFam && callerId != null) {
    try {
      const callerRow = registry.find((r) => r && String(r.id) === String(callerId));
      if (callerRow && idFam.crossLinkedIdentity(callerRow, row)) return false; // SELF — the caller IS this partition's owner, so IT acks it (Wave 9: returning true here stranded the twin's cursor at its pre-read value and re-delivered the same rows forever)
    } catch (_) { /* fall through to the plain liveness check below */ }
  }
  let live;
  try {
    live = isSiblingPartitionLive({ id: partId, worktreePath: row.worktreePath, sessionId: row.sessionId }, home, { now });
  } catch (_) {
    return true; // undetermined -> fail toward live, never ack
  }
  if (live) return true;
  if (idFam) {
    try {
      const twins = idFam.identityFamilyTwins(row, registry.filter((r) => r && String(r.id) !== String(partId)));
      for (const t of twins) {
        let twinLive = false;
        try { twinLive = isSiblingPartitionLive({ id: t.id, worktreePath: t.worktreePath, sessionId: t.sessionId }, home, { now }); } catch (_) { twinLive = false; }
        if (twinLive) return true; // partId's own twin identity is live -> partId is live too
      }
    } catch (_) { /* fall through — partId's own (not-live) verdict stands */ }
  }
  return false;
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

// broadcastFamilyOwns(s, caller, id, home, ownEntry, cwd, callerSessionId,
// hadPriorHeartbeat) -> bool.
// The IDENTITY-FAMILY leg of cmdHeartbeat's meshBroadcast ownership check (defect
// ecd7ad60e4cc). True when `id` names a row that belongs to the SAME workspace
// identity the caller does — never on raw-id equality alone (that is the caller's
// own first two legs) and never on anything a caller can forge.
//
// R15 P2 FIX (field-reproduced): SAME WORKTREE ALONE used to be sufficient (leg
// (a) below), which let ANY caller sharing the target's worktree broadcast as it
// — two unrelated live sessions co-registered in one worktree (the ordinary
// multi-tab/multi-agent case, not a spoof) could impersonate each other
// (Critic repro: `heartbeat <victim-id> --summary` from an unrelated same-
// worktree caller returned ok:true). Same-worktree is still REQUIRED for leg
// (a) — a process outside the target's worktree gets no credit from it at all
// — but is no longer SUFFICIENT: an identity link is now also required, one of:
//   (a1) crossLinkedIdentity(ownEntry, targetRow) — the strongest unambiguous
//        link: one row's sessionId IS the other row's id (the builder-id-UUID
//        + slug-row pair, devswarm-identity-family.js's documented shape).
//        Checked FIRST and unconditionally (not gated on same-worktree) — a
//        legitimately cross-linked twin is owned regardless of worktree.
//   (a2) the target row's OWN sessionId equals the CALLER's real session id —
//        the session value THIS call itself was invoked under (cmdHeartbeat's
//        own `--session`, the same field a legitimate registration stamps).
//        Direct proof the target row was registered under the exact session
//        now presenting the broadcast, with no cross-link chain needed.
//   (a3) the target row is a PLACEHOLDER — no descriptor file AND no
//        heartbeat file of its own PRE-EXISTING before this very call
//        (`hadPriorHeartbeat`, captured by the caller BEFORE this call's own
//        base-heartbeat write — that write always happens, so checking
//        current existence here would always read true for the one id this
//        call is ever asked about). Nothing to spoof: a placeholder is not a
//        live, claimed workspace with any real state a forged broadcast
//        could compromise (the `unclaimed:` anchor-row shape).
//
// FAIL-CLOSED in full: any throw, an unresolvable worktree, or a target id with
// no registry row returns false, leaving the refusal exactly as it is today.
function broadcastFamilyOwns(s, caller, id, home, ownEntry, cwd, callerSessionId, hadPriorHeartbeat) {
  try {
    const target = String(id);
    const rows = s.listRegistry() || [];
    const targetRow = rows.find((r) => r && String(r.id) === target) || null;
    if (!targetRow || !targetRow.worktreePath) return false;
    let tKey = null;
    try { tKey = canonicalMeshId(targetRow.worktreePath); } catch (_) { tKey = null; }
    if (!tKey) return false;
    // (a1) cross-linked identity between the caller's row and the target row —
    // unconditional, not gated on same-worktree.
    if (ownEntry) {
      try {
        const idFam = require('../companion/lib/devswarm-identity-family.js');
        if (idFam.crossLinkedIdentity(ownEntry, targetRow)) return true;
      } catch (_) {}
    }
    // Same-worktree precondition for the remaining legs (a2)/(a3) — the
    // caller's own cwd-resolved worktree, or the caller's own registry row's
    // worktree.
    let sameWorktree = false;
    const rawCwd = cwd || process.cwd();
    const wt = resolveCallerWorktree(rawCwd);
    if (wt) {
      try { if (canonicalMeshId(wt) === tKey) sameWorktree = true; } catch (_) {}
    }
    if (!sameWorktree && ownEntry && ownEntry.worktreePath) {
      try { if (canonicalMeshId(ownEntry.worktreePath) === tKey) sameWorktree = true; } catch (_) {}
    }
    if (!sameWorktree) return false;
    // (a2) the target row's own sessionId matches the caller's real session id
    if (callerSessionId != null && targetRow.sessionId != null
      && String(targetRow.sessionId) === String(callerSessionId)) {
      return true;
    }
    // (a3) the target row is a placeholder: no descriptor, no PRE-EXISTING
    // heartbeat of its own (see hadPriorHeartbeat's header note above)
    try {
      const hasDescriptor = !!readDescriptorFile(home, target);
      if (!hasDescriptor && !hadPriorHeartbeat) return true;
    } catch (_) {}
    return false;
  } catch (_) { return false; }
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

// ---------------------------------------------------------------------------
// P0 HOTFIX (v0.90.1) — CURSOR NAMESPACES FOR A MESH SIBLING PARTITION
//
// A partition carries TWO store-side read positions that both mean "how far
// this partition has been consumed", written by DIFFERENT code paths:
//   (A) `cursors/<id>.json`  — the read-path ack file (inboxCursor / this
//       file's primaryCursorPath), written by `read-primary`'s ack loop.
//   (B) the store's own cursor row (s.cursorValue/s.setCursor), written by
//       `inbox count`'s reader, by foldOne's post-forward advance, and by
//       `reap-orphans`' post-archive advance.
//
// FIELD DEFECT: `read-primary` sized a sibling's window from (A) alone while
// `inbox count` sized it from (B) alone. After a fold or a reap advanced (B)
// to 606 with (A) still 0, `count` reported 0 unread while `read-primary`
// re-delivered all 606 rows on EVERY read, forever (measured: count 1 vs read
// 201 on the same storeSeq). Two surfaces disagreeing about how far a
// partition has been read is the whole defect.
//
// FIX: BOTH surfaces size from `Math.max(A, B)`. MAX is LOSS-FREE here — it is
// not the generic "max is unsafe, min is safe" case reconcileOrphanCursor
// documents, because the only writers that can push (B) ahead of (A) are
// foldOne and cmdReapOrphans, and each advances it ONLY AFTER the rows behind
// it were forwarded into a survivor partition (foldOne) or archived to disk
// (cmdReapOrphans). Rows below max(A,B) are therefore provably reachable
// somewhere else; skipping them here loses nothing. Those two writers now also
// write (A) in lockstep (see their call sites), so new divergence cannot open.
function siblingBaseCursor(storeHandle, home, pid) {
  let jsonCursor = 0, storeCursor = 0;
  try { jsonCursor = inboxCursor.readCursor(primaryCursorPath(home, pid)); } catch (_) { jsonCursor = 0; }
  try { storeCursor = storeHandle.cursorValue(pid); } catch (_) { storeCursor = 0; }
  return Math.max(jsonCursor, storeCursor);
}

// ---------------------------------------------------------------------------
// LIVE-SIBLING WATERMARK (P0 hotfix, v0.90.1) — `cursors/<callerId>.seen-<siblingId>.json`
//
// A sibling partition owned by a LIVE twin is NOT ackable: `siblingAckGate`
// refuses (correctly — the twin's own reader owns that cursor, and advancing it
// from here would eat the twin's mail). But `read-primary` still DELIVERS that
// sibling's unread rows to the caller, and with no cursor written anywhere the
// window is identical on the next read: the SAME rows are re-delivered on every
// single read, forever. That is the recurring re-delivery this hotfix closes.
//
// This watermark is CALLER-SCOPED: it records how far THIS caller has been
// shown of THAT sibling. It NEVER touches the sibling's own cursor namespaces,
// so the twin's own reader still sees 100% of its mail. It is consulted ONLY
// for a non-ackable sibling (an ackable one advances its real cursor as before).
// Both ids are isSafeId-checked so the filename can never escape cursors/.
//
// R14 F3 (P3) — THE NAME MUST BE UNAMBIGUOUSLY PARSEABLE. isSafeId permits `.`
// and `-`, so an id literally containing the `.seen-` separator would make
// `<caller>.seen-<sibling>.json` ambiguous: `a.seen-b.seen-c.json` could be
// (a, b.seen-c) or (a.seen-b, c). Nothing WRITES such a name today, but a
// hygiene sweep that DELETES files has to parse them, and a mis-parse there
// deletes the wrong caller's watermark. Rather than re-encode every id (a
// persisted-shape change requiring a forward migration for every existing
// file), refuse the one token that creates the ambiguity: an id containing
// `.seen-` gets NO watermark. That is fail-soft in the safe direction — such a
// caller/sibling pair simply falls back to the pre-watermark behaviour — and it
// makes "split on the first `.seen-`" an exact inverse for every name this
// function can ever produce.
const SIBLING_SEEN_SEP = '.seen-';
function watermarkSafeId(id) {
  return isSafeId(id) && !String(id).includes(SIBLING_SEEN_SEP);
}
function siblingSeenCursorPath(home, callerId, siblingId) {
  if (!watermarkSafeId(callerId) || !watermarkSafeId(siblingId)) return null;
  return path.join(devswarmRoot(home), 'cursors', String(callerId) + SIBLING_SEEN_SEP + String(siblingId) + '.json');
}
// parseSiblingSeenCursorName(filename) -> { callerId, siblingId } | null.
// The exact inverse of siblingSeenCursorPath's naming, and the ONE parser any
// sweep may use. Returns null for a name this module could not have written —
// including a legacy/hand-made name whose remainder still contains the
// separator (genuinely ambiguous), which a sweep must therefore SKIP rather
// than guess at and delete.
function parseSiblingSeenCursorName(filename) {
  const n = typeof filename === 'string' ? filename : '';
  if (!/\.json$/.test(n)) return null;
  const base = n.slice(0, -'.json'.length);
  const i = base.indexOf(SIBLING_SEEN_SEP);
  if (i <= 0) return null;
  const callerId = base.slice(0, i);
  const siblingId = base.slice(i + SIBLING_SEEN_SEP.length);
  if (!watermarkSafeId(callerId) || !watermarkSafeId(siblingId)) return null;
  return { callerId, siblingId };
}
// removeSiblingSeenCursor(home, callerId, siblingId) -> bool. Deletes the
// watermark FILE once the sibling's own durable cursors cover its rows (see the
// read-primary ack path). Never a message delete — a watermark is a per-caller
// read position, and its absence degrades to "re-read from the real cursor",
// which is exactly the pre-watermark behaviour. Fail-soft: a missing file or an
// unlink error returns false and changes nothing.
function removeSiblingSeenCursor(home, callerId, siblingId) {
  const p = siblingSeenCursorPath(home, callerId, siblingId);
  if (!p) return false;
  try { fs.unlinkSync(p); return true; } catch (_) { return false; }
}
function readSiblingSeenCursor(home, callerId, siblingId) {
  const p = siblingSeenCursorPath(home, callerId, siblingId);
  if (!p) return 0;
  try { return inboxCursor.readCursor(p); } catch (_) { return 0; }
}
function writeSiblingSeenCursor(home, callerId, siblingId, value) {
  const p = siblingSeenCursorPath(home, callerId, siblingId);
  if (!p || !Number.isFinite(value) || value <= 0) return false;
  try { inboxCursor.ackTo(p, value); return true; } catch (_) { return false; }
}
// watermarkLockKey(callerId, siblingId) -> string | null. D11-A (TOCTOU fix):
// the per-id lock key for THIS (callerId, siblingId) watermark file — reuses
// the file's OWN basename convention (siblingSeenCursorPath minus `.json`),
// which is already watermarkSafeId-gated on both halves (isSafeId-safe, no
// `.seen-` substring ambiguity), so it needs no separate validation and can
// never collide with an unrelated single-id lock (every other withIdLock
// caller in this file locks a bare workspace id, which never contains
// `.seen-`). Returns null when either id is not watermarkSafeId (mirrors
// siblingSeenCursorPath's own null-on-unsafe-id contract) — callers fall back
// to running unlocked, same as the pre-fix behavior for that edge case.
function watermarkLockKey(callerId, siblingId) {
  if (!watermarkSafeId(callerId) || !watermarkSafeId(siblingId)) return null;
  return String(callerId) + SIBLING_SEEN_SEP + String(siblingId);
}
// withWatermarkLock(callerId, siblingId, home, fn) -> fn()'s return value.
// D11-A (TOCTOU fix, ~:6394): the sibling-watermark read (readSiblingSeenCursor)
// -> conditional unlink (removeSiblingSeenCursor) at the read-primary ack path
// used to run with NO file locking at all — a concurrent writeSiblingSeenCursor
// call for the SAME (callerId, siblingId) pair (e.g. two overlapping
// `inbox read-primary` invocations by the same caller reading the same
// non-ackable sibling) could land its write in the gap between the read and
// the unlink, and that extension would be silently discarded when the unlink
// fired (documented, pre-fix, at readSiblingSeenCursor's TOCTOU header
// comment). Serializing BOTH the write site (the notAckable branch) and the
// read+conditional-unlink site under the SAME per-(callerId,siblingId) lock
// closes the window: whichever caller wins the lock completes its full
// read-modify-write (or write) atomically w.r.t. the other. FAIL-OPEN,
// matching withIdLock's own posture: a lock-busy result (contended, budget
// exhausted) runs `fn` UNLOCKED rather than silently dropping the operation —
// a watermark is best-effort re-delivery bookkeeping (its own header: "its
// absence degrades to re-read from the real cursor, which is exactly the
// pre-watermark behaviour"), so losing this one race under contention is
// strictly safer than refusing the read/write outright. An unresolvable lock
// key (unsafe ids) also runs unlocked — same edge case
// siblingSeenCursorPath/writeSiblingSeenCursor already degrade to a no-op for.
function withWatermarkLock(callerId, siblingId, home, fn) {
  const key = watermarkLockKey(callerId, siblingId);
  if (!key) return fn();
  const r = withIdLock(key, home, fn);
  if (r && typeof r === 'object' && r.lockBusy) return fn(); // contended -> fail-open, run unlocked rather than drop
  return r;
}
// siblingWatermarkCovered(ackTarget, watermarkValue) -> bool. The REAL
// invariant the R14 F1 THIRD HALF watermark retirement needs (R15 P3 fix):
// true iff advancing the sibling's own durable cursor to `ackTarget` covers
// every row the watermark recorded. Extracted into its own pure predicate
// (rather than inlined against a cached in-memory value) so it is directly
// unit-testable, and so the read-primary call site can gate it on a FRESHLY
// read `watermarkValue` (see readSiblingSeenCursor at that call site) instead
// of an in-memory value captured earlier in the same read. The fresh re-read
// narrows the TOCTOU window to just read→unlink, it does not eliminate it:
// there is no file locking here, so a writer that extends the watermark in
// that gap loses that extension when the unlink fires, and the next acking
// read simply recreates the file from the writer's own state. A non-finite
// input on either side degrades to 0 — no watermark on record (missing/
// unreadable file) trivially satisfies "covered".
function siblingWatermarkCovered(ackTarget, watermarkValue) {
  const target = Number.isFinite(ackTarget) ? ackTarget : 0;
  const w = Number.isFinite(watermarkValue) ? watermarkValue : 0;
  return target >= w;
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
// VALUE_REQUIRED_FLAGS (FIX 4b, TRACED): flags whose value is NEVER a bare boolean
// — the next token is consumed unconditionally, even when it itself starts with
// `--` (e.g. `--message "--foo bar"`). Without this, such a value degrades to the
// bare-boolean branch below (`val = true`) and the flag silently loses its text.
// Deliberately scoped to flags that only ever take a value, so this cannot swallow
// the next token for a genuinely boolean flag (e.g. `--json`, `--ack`, `--stdin`).
const VALUE_REQUIRED_FLAGS = new Set(['message', 'message-file']);
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
  // origHash (defect 64861a623503) — carried on BOTH shapes. A verbatim re-home
  // must preserve it like every other stored field; a FORWARD of an already-
  // forwarded row must keep pointing at the ROOT original (never at the
  // intermediate copy), which is exactly what copying the source row's own
  // origHash through achieves. A forward of a NON-forwarded row has nothing to
  // copy here (null) and the forward site supplies `origHash: m.hash` via
  // `overrides`, which is applied last.
  { row: 'origHash', msg: 'origHash' },
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

// ARCHIVE_FORWARD_MAX_AGE_DAYS_DEFAULT / archiveForwardMaxAgeMs(env) — the age cap
// on forwarding an ARCHIVED orphan's unread into a live family survivor (see
// forwardArchivedOrphanUnread below / healOrphanPartitions' archived branch).
// Resurfacing a month-old, possibly-stale instruction into a live sibling out of
// context is real harm, not tidiness — a message that sat unread since the
// workspace was archived is not "fresh traffic". Overridable per the same
// ANTIHALL_<FEATURE>_<PARAM> env-tunable convention this repo's hooks use
// (e.g. ANTIHALL_API_GUARD_SPAWN_TIMEOUT_MS, ANTIHALL_CODEX_NUDGE_MIN).
const ARCHIVE_FORWARD_MAX_AGE_DAYS_DEFAULT = 30;
function archiveForwardMaxAgeMs(env) {
  const e = env || process.env;
  const raw = e ? e.ANTIHALL_DEVSWARM_ARCHIVE_FORWARD_MAX_AGE_DAYS : undefined;
  const days = parseInt(raw, 10);
  const effectiveDays = Number.isFinite(days) && days > 0 ? days : ARCHIVE_FORWARD_MAX_AGE_DAYS_DEFAULT;
  return effectiveDays * 24 * 60 * 60 * 1000;
}
// archivedForwardProvenancePrefix(id) — the marker prepended to a forwarded
// archived-orphan body so the survivor (and anyone reading its inbox) can tell a
// resurfaced message from fresh traffic, per the same forward envelope
// (MESH_ROW_COPY_FIELDS/meshRowCopy) every other forward site in this file uses —
// no parallel format invented.
function archivedForwardProvenancePrefix(id) { return '[forwarded from archived ' + id + '] '; }
// The READ half of archivedForwardProvenancePrefix — the ONE regex that
// recognises (and can strip) that envelope, so the prefix format is written in
// exactly one place and parsed in exactly one place.
const ARCHIVED_FORWARD_PREFIX_RE = /^\[forwarded from archived ([^\]]+)\] /;

// stripArchivedForwardPrefix(body) -> { archivedId, body }. `archivedId` is null
// (and `body` returned verbatim) for a row that is not an archived forward.
function stripArchivedForwardPrefix(body) {
  if (typeof body !== 'string') return { archivedId: null, body: '' };
  const m = ARCHIVED_FORWARD_PREFIX_RE.exec(body);
  if (!m) return { archivedId: null, body };
  return { archivedId: m[1], body: body.slice(m[0].length) };
}

// forwardedOrigHashOf(row) -> the ORIGINAL row's hash for a forwarded copy, or
// null (defect 64861a623503).
//
// Two tiers, in order:
//   1. `row.origHash` — stamped at forward time by forwardArchivedOrphanUnread
//      from this build on. Authoritative; no reconstruction needed.
//   2. RECONSTRUCTION for a row forwarded by an OLDER build (no origHash
//      column value): every field the original's hash was computed over is
//      still recoverable from the forwarded row itself, because the forward
//      envelope changes exactly two of them and both are invertible —
//      `to` (the new survivor) is replaced by the archived id the provenance
//      prefix names, and `message` gains that prefix, which is stripped back
//      off. `from`/`timestamp`/`urgency`/`needsReply` are carried VERBATIM by
//      MESH_ROW_COPY_FIELDS, and `type` is always 'direct' (isForwardable
//      admits nothing else). So meshMessageHash over those recovered fields
//      reproduces the original's hash byte-for-byte — no store lookup, no
//      persisted backfill, and therefore no migration needed for the ~438
//      archived forwards already sitting in a field Primary's partitions.
//
// Fail-soft: any unexpected shape returns null (no dedup signal), never throws.
function forwardedOrigHashOf(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.origHash != null && String(row.origHash) !== '') return String(row.origHash);
  const parsed = stripArchivedForwardPrefix(row.body);
  if (!parsed.archivedId) return null;
  try {
    return store.meshMessageHash({
      from: row.sender,
      to: parsed.archivedId,
      type: 'direct',
      urgency: row.urgency,
      message: parsed.body,
      timestamp: row.ts,
      needsReply: row.needsReply,
    });
  } catch (_) { return null; }
}

// logicalDeliveryKey(row) -> a SECONDARY, weaker identity: (from, ts,
// prefix-stripped body). The exact-hash tier above is the primary and only
// cursor-affecting one; this key exists solely to suppress the OTHER shape the
// field report measured — 75 EXACT RESENDS that are not archived forwards at
// all and therefore share neither `hash` nor `origHash` with the copy the
// reader already handled.
//
// DELIVERY-TIME SUPPRESSION ONLY. This key is deliberately weaker than a hash
// (two genuinely distinct messages sent by the same sender at the same
// millisecond with identical text would collide), so a match must NEVER advance
// a cursor past the row — see foldSiblingGapRows, where a logically-suppressed
// row is withheld exactly like a gap row: not delivered, and NOT consumed, so
// the row stays permanently reachable by reading its partition directly.
function logicalDeliveryKey(row) {
  if (!row || typeof row !== 'object') return null;
  const from = row.sender != null ? String(row.sender) : '';
  const ts = row.ts != null ? String(row.ts) : '';
  const body = stripArchivedForwardPrefix(row.body).body;
  if (from === '' && ts === '' && body === '') return null;
  return from + ' ' + ts + ' ' + body;
}

// CONSUMED_HASH_SEED_CAP — how many of the caller's OWN already-consumed rows
// (the newest ones, immediately below its cursor) are scanned to seed the dedup
// sets. Bounded because a long-lived Primary's partition is append-only and
// never pruned: seeding from the FULL history would make every read O(history).
// 2000 is far past any plausible in-flight forward wave (the field incident's
// was 608 rows) while staying a trivially cheap slice of an already-materialised
// listMessages array.
const CONSUMED_HASH_SEED_CAP = 2000;

// consumedDedupSeed(s, id, cursor, cap) -> { hashes:Set, logical:Set }.
//
// ROOT CAUSE this closes (defect 64861a623503): `seenHashes` used to be seeded
// ONLY from the caller's CURRENT UNREAD rows, so a forwarded copy could only
// ever be matched against a message still sitting unread. The field case is the
// opposite one — the Primary had ALREADY CONSUMED all 438 originals, so there
// was nothing left in `unread` to match against and every forward was delivered
// as new. Seeding from CONSUMED history (rows below the cursor) is what makes
// "I have already handled this" expressible at all.
//
// Cheapest available consumed-hash source: the caller's OWN partition rows below
// its own cursor, from the SAME `listMessages` read path everything else uses,
// bounded to the newest `cap` of them. No new index, no new persisted state.
// Fail-soft: an unreadable store yields empty sets (dedup simply does not fire).
function consumedDedupSeed(s, id, cursor, cap) {
  const out = { hashes: new Set(), logical: new Set() };
  const c = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
  if (c <= 0) return out;
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : CONSUMED_HASH_SEED_CAP;
  let rows = [];
  try { rows = s.listMessages(id) || []; } catch (_) { return out; }
  const end = Math.min(c, rows.length);
  for (let i = Math.max(0, end - limit); i < end; i++) {
    const row = rows[i];
    if (!row) continue;
    if (row.hash) out.hashes.add(String(row.hash));
    const oh = forwardedOrigHashOf(row);
    if (oh) out.hashes.add(oh);
    const lk = logicalDeliveryKey(row);
    if (lk) out.logical.add(lk);
  }
  return out;
}

// forwardArchivedOrphanUnread(s, id, survivorId, opts) — forward-only (NEVER
// adopts/upserts a registry row for `id`) copy of an archived orphan's unread
// DIRECTS into `survivorId`, using the SAME meshRowCopy/MESH_ROW_COPY_FIELDS
// envelope + isForwardable filter + recomputed-hash dedup every other forward site
// in this file uses (foldGroupIntoSurvivor's foldOne). Two additions specific to
// an ARCHIVED source, both from FIX B's decided policy:
//   - each forwarded body is prefixed with archivedForwardProvenancePrefix so the
//     resurfaced message is never mistaken for fresh traffic.
//   - any unread row older than opts.maxAgeMs is skipped entirely (counted in
//     `stale`, never forwarded, never dedup-hashed) — resurfacing month-old
//     instructions into a live sibling out of context is real harm.
// Pure per-id op: never touches the registry, never tombstones, never advances a
// cursor (cursor reconciliation is the caller's separate MIN-only step). Returns
// { forwarded, stale }.
function forwardArchivedOrphanUnread(s, id, survivorId, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const maxAgeMs = Number.isFinite(o.maxAgeMs) && o.maxAgeMs > 0 ? o.maxAgeMs : archiveForwardMaxAgeMs();
  let forwarded = 0;
  let stale = 0;
  let since = 0;
  try { since = s.cursorValue(id); } catch (_) { since = 0; }
  let rows = [];
  try { rows = s.listMessages(id, { sinceCursor: since }); } catch (_) { rows = []; }
  for (const m of rows) {
    if (!isForwardable(m)) continue;
    const ts = Number(m.ts);
    if (Number.isFinite(ts) && (now - ts) > maxAgeMs) { stale++; continue; }
    const fields = meshRowCopy(m, 'message', {
      to: survivorId, type: 'direct', urgency: m.urgency || 'normal',
      message: archivedForwardProvenancePrefix(id) + (m.body != null ? m.body : ''),
      // EXACT CROSS-PARTITION DEDUP (defect 64861a623503). The forward
      // RE-ADDRESSES the row, so its own hash necessarily differs from the
      // original's and no reader could ever match the copy against a message it
      // already consumed — the field failure that re-delivered 438 archived
      // forwards to a Primary that had handled every one of them. Stamp the
      // ORIGINAL's identity onto the copy so `foldSiblingGapRows` can suppress
      // it. `m.origHash || m.hash`: a chain of forwards keeps pointing at the
      // ROOT original, never at the intermediate copy.
      origHash: (m.origHash != null ? m.origHash : m.hash) || null,
    });
    const hash = store.meshMessageHash(fields);
    const r = store.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    if (r && r.inserted) forwarded++;
  }
  return { forwarded, stale };
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
      //
      // D11-A SCOPE NOTE: isLiveSessionId here is DELIBERATELY the bare shape
      // test, NOT migrated to isRoutingLiveRow/isSiblingPartitionLive like
      // resolveMeshTarget/pickSurvivor/groupRegistryByMeshId's liveRows (see
      // the header above SYNTHETIC_SESSION_PREFIX). Two independent reasons:
      // (1) this is an IDENTITY-MATCH question (is curRow the SAME entity
      // desc describes), not a drain/routing decision — a session that is
      // real but has since gone dormant is still the SAME entity, and gating
      // this comparison on current liveness would refuse a legitimate heal
      // for a merely-idle (not dead) workspace. (2) the descriptor-existence
      // fallback isRoutingLiveRow needs for a just-registered row is
      // structurally meaningless here: `desc` was ITSELF obtained via
      // readDescriptorFile a few lines above, so that fallback would read
      // true unconditionally and silently defeat the whole confirmedMatch
      // gate — exactly the foreign-descriptor-takeover this guard exists to
      // refuse.
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
    // Defect-2(b) fix: same detect-and-skip as rehomeStrandedProjectDescriptors
    // above — a registry row whose worktree is gone on disk AND already has an
    // archived/ counterpart for its id is not a live target for the heal pass.
    // Detect-only, never deletes/unlinks the row or the archived counterpart.
    if (row.worktreePath) {
      let worktreeExists = true;
      try { worktreeExists = fs.existsSync(row.worktreePath); } catch (_) { worktreeExists = true; }
      if (!worktreeExists && hasArchivedCounterpart(home, String(row.id))) { out.skipped++; continue; }
    }
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
  // FOREIGN-STRAND GUARD (defect e586afdaa968, P0). "Stranded in the hash
  // bucket" says WHERE the rows physically live; it says NOTHING about WHICH
  // project the workspace belongs to. A workspace whose worktree genuinely
  // lives in project B, registered from a non-git cwd (so ownerKey === the
  // hash bucket), was re-homed into whatever project the CALLER happened to be
  // standing in — physically copying B's registry row + messages into A and
  // rewriting the descriptor's ownerKey to A. Every caller of this function
  // (read, gate, and — via their own inline rehomeCore blocks — ensure and
  // archive) then had another project's data moved under it, INCLUDING the
  // calls that went on to refuse with ok:false. The heal is only ever correct
  // toward the workspace's OWN registered project, so: when the id's registered
  // key positively resolves and disagrees with this cwd, do nothing.
  // Fail-open unchanged: a workspace that names no project at all (the legacy
  // no-project mode — registeredRepoKey returns null for exactly the hash
  // bucket it is stranded in) still heals here, as before.
  const registeredKey = descriptorRegisteredRepoKey(desc, id);
  if (registeredKey && registeredKey !== repoKey) return null;
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

// foldSiblingGapRows(rows, seenHashes) — Fix Wave 2 F1/F3 (P0 message-loss fix
// + surface-parity fix): shared gap-withholding fold used by BOTH mesh-sibling
// read paths (cmdInboxMessages's read-primary/peek-primary/--ack, and `inbox
// count/read/ack`'s own sibling loop) so they can no longer silently diverge
// (that divergence was F3/F2's root cause).
//
// ROOT CAUSE this replaces (F1, defect confirmed live): the prior fold set
// `gapSeen` on a non-forwardable/null row but still PUSHED that row into
// `deliveredRows`, so withholding was NON-SUFFIX — a withheld forwardable row
// could sit BETWEEN two delivered rows (e.g. [native N0, direct F1, native
// N2] delivered [N0, N2], withholding only F1). The sibling ack target is
// POSITIONAL (`part.cursor + deliveredCount`), which is only valid over a
// CONTIGUOUS PREFIX of the partition's natural (cursor) order. `ack` on that
// window advanced the cursor by 2 (past N0 AND the withheld F1), destroying
// F1 permanently — proven live, absent at HEAD.
//
// FIX (option (b), chosen over capping ackTarget at the first-gap index):
// restore the documented invariant VERBATIM — once a gap is seen, EVERY
// subsequent row is withheld, including non-forwardable ones. This makes
// `deliveredRows` a genuine index-based PREFIX of `rows` (the row that
// TRIGGERS the gap is itself still delivered — "never excluded" — but
// nothing after it is), so `deliveredCount` is always safe to add to
// `part.cursor` for the ack target. A partition with no non-forwardable row
// in its window has no gap at all, so nothing is withheld (P0 case
// unaffected, re-asserted as a guard test).
//
// F5 fix folded in here too: a null row (store corruption) is skipped
// entirely (never pushed as a literal `null`) but still poisons the window
// like any other non-forwardable row, since its safety cannot be determined.
// Fix Wave 3 G1/G2 (P0/P1): `deliveredCount` (== `deliveredRows.length`) used
// to ALSO be the number the ack loops (~line 4064/4209, ~line 4580/4803) add
// to `part.cursor` for the ack target. That conflated two DIFFERENT things:
// (1) how many rows the CALLER actually got back (the payload), and (2) how
// many PHYSICAL rows of `rows` were resolved and can safely be skipped past
// on the next read. They agree only when every resolved row is also a
// delivered row (the common case) — they diverge whenever a row is resolved
// WITHOUT being delivered:
//   G1 (P0, corrupted/null row): `if (!row)` skips a hole entirely — never
//   pushed, so it never counted toward `deliveredCount`. The ack target
//   `part.cursor + deliveredCount` then NEVER advances past that row, so
//   EVERY future read starts the window at the same hole again — permanent,
//   operator-unrecoverable wedge (no read/ack sequence can ever progress),
//   with `count` silently reporting `unreadTotal: 0` on top of it (nothing
//   in the window counted as delivered either).
//   G2 (P1, exact-hash duplicate): `if (row.hash && seenHashes.has(...))`
//   skips a dedup match — also never pushed. `deliveredRows` then stops
//   being a genuine PHYSICAL index-prefix of `rows` (it can be shorter than
//   the number of physical rows actually consumed to produce it), so an ack
//   loop that advances a sibling's cursor by `deliveredCount` UNDER-covers
//   the physical rows behind it and can redeliver a row already returned.
//
// FIX: track `consumedCount`/`consumedThrough` SEPARATELY from
// `deliveredRows`/`deliveredCount`. `consumedCount` is the number of
// PHYSICAL rows from the front of `rows` that have been resolved one way or
// another (delivered, exact-hash-deduped, OR corrupted/null) while still
// inside the ackable prefix (i.e. before `gapSeen` was true at the START of
// processing that row) — this is what an ack target must add to
// `part.cursor`, never `deliveredCount`. `consumedThrough[i]` records
// `consumedCount` at the moment `deliveredRows[i]` was pushed, so a caller
// that only delivers/keeps the first K of `deliveredRows` (the P2-D read cap)
// can still derive the CORRECT physical ack target for that partial delivery
// (`consumedThrough[K - 1]`, or 0 when K is 0) rather than assuming K
// physical rows were consumed to produce K delivered rows.
//
// A corrupted/null row is therefore consumed (the ack cursor moves past it —
// there both was never a real message there, and it is unrecoverable either
// way) but still poisons the REST of THIS read's window exactly as before
// (nothing after it in this call is delivered or consumed) — the wedge is
// broken because the poisoned row itself is gone from the NEXT read's
// window, so whatever follows it becomes the new (clean) window head and
// gets a normal chance to deliver. `deliveredRows`/`deliveredCount`/
// `gapWithheldCount` are computed IDENTICALLY to before this fix — this is a
// strictly additive change, byte-compatible with every existing caller that
// only reads those three fields.
// EXACT CROSS-PARTITION DEDUP (defect 64861a623503, additive to everything
// above). Two changes, and a THIRD parameter that is optional so every existing
// caller and test keeps byte-identical behaviour:
//
//   (a) `seenHashes` is now matched against a row's `origHash` as well as its
//       own `hash` — a forwarded copy carries the ORIGINAL's hash there (or has
//       it reconstructed, see forwardedOrigHashOf), so a copy of an original the
//       caller ALREADY CONSUMED is recognised as the exact same logical message.
//       It is treated exactly like the pre-existing exact-hash duplicate: not
//       delivered, but CONSUMED (the cursor may pass it), because a hash match
//       is proof of identity.
//
//   (b) `seenLogical` (optional Set) adds the WEAKER (from, ts, stripped-body)
//       key for the exact-resend shape that shares no hash at all.
//
//       ROUND 13 R1 RULING — a weak-key match now CONSUMES (it did not).
//       The original form suppressed WITHOUT consuming: the row was neither
//       delivered nor counted toward `consumedCount`, AND it set `gapSeen`.
//       That POISONS THE WINDOW permanently — the ack target derived from
//       `consumedCount` stops BEFORE the row, so the very next read starts on
//       the same suppressed row again, sets `gapSeen` again, and withholds
//       everything behind it forever. The "reachable by reading its partition
//       directly" escape hatch does not save the window: the partition's own
//       cursor can never move past it either. That is the same operator-
//       unrecoverable wedge G1 fixed for corrupted rows, reintroduced for
//       weak-key matches.
//
//       A weak-key match is now treated like the exact-hash duplicate above:
//       NOT delivered (the caller already has a logically identical row from
//       this same fold) but CONSUMED, so the cursor passes it and the window
//       makes progress. `gapSeen` is NOT set — a consumed row ends nothing.
//       The residual risk this accepts is the mirror of the old one: a
//       genuinely-new row that collides on the weak key is skipped rather than
//       withheld. `logicalDeliveryKey` is (from, ts-to-the-millisecond,
//       stripped body) — a collision means the same sender emitted a
//       byte-identical body in the same millisecond, which is a resend, not a
//       distinct message. Each suppression emits ONE NDJSON diagnostic line
//       ({reason:'logical-dup', from, ts}) so the trade is observable in the
//       field rather than silent. `logicalSuppressedCount` is unchanged in
//       meaning and still reported.
function foldSiblingGapRows(rows, seenHashes, seenLogical) {
  const deliveredRows = [];
  const consumedThrough = [];
  let gapSeen = false;
  let gapWithheldCount = 0;
  let consumedCount = 0;
  let logicalSuppressedCount = 0;
  for (const row of rows) {
    const wasGapSeen = gapSeen; // gapSeen state at the START of this row, before any mutation below
    if (!row) { // F5: corrupted row skipped, still poisons subsequent rows
      gapSeen = true;
      if (!wasGapSeen) consumedCount++; // G1: unrecoverable either way — consume it so the ack cursor can pass it forever
      continue;
    }
    const origHash = forwardedOrigHashOf(row);
    // exact-hash duplicate (own hash OR the original's, for a forwarded copy) —
    // never counted as withheld
    if ((row.hash && seenHashes.has(row.hash)) || (origHash && seenHashes.has(origHash))) {
      if (!wasGapSeen) consumedCount++; // G2: a physical row was resolved here even though nothing was delivered
      continue;
    }
    if (wasGapSeen) { gapWithheldCount++; continue; } // ambiguous suffix — withheld (never lost, cursor never touches it)
    // (b) WEAK logical suppression — see this function's header (ROUND 13 R1).
    // CONSUMED, exactly like the exact-hash duplicate above: not delivered, but
    // the cursor may pass it, and `gapSeen` is NOT set. The old
    // suppress-without-consume form wedged the window on the same row forever.
    let logicalKey = null;
    if (seenLogical) {
      logicalKey = logicalDeliveryKey(row);
      if (logicalKey && seenLogical.has(logicalKey)) {
        consumedCount++;
        logicalSuppressedCount++;
        try {
          if (alog && typeof alog.logEvent === 'function') {
            alog.logEvent('devswarm-cli', 'sibling-fold-logical-dup', 'info',
              'suppressed a logically-duplicate sibling row (weak key match)',
              { reason: 'logical-dup', from: row.from != null ? String(row.from) : null, ts: Number.isFinite(row.ts) ? row.ts : null });
          }
        } catch (_) { /* diagnostics never affect the fold */ }
        continue;
      }
    }
    if (!isForwardable(row)) gapSeen = true; // non-forwardable: delivered now, ends this window's deliverable prefix
    if (row.hash) seenHashes.add(row.hash);
    // Register the ORIGINAL's identity too, so a later row in THIS same fold
    // that IS that original (or another copy of it) is suppressed symmetrically.
    if (origHash) seenHashes.add(origHash);
    if (seenLogical && logicalKey) seenLogical.add(logicalKey);
    consumedCount++;
    deliveredRows.push(row);
    consumedThrough.push(consumedCount);
  }
  return {
    deliveredRows, deliveredCount: deliveredRows.length, gapWithheldCount,
    consumedCount, consumedThrough, logicalSuppressedCount,
  };
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
  // P0-B fix, CORRECTED (see below): an EARLIER version of this fix bypassed the
  // descriptor gate outright on the theory that every caller already proves
  // canonicalWorktreeRealPath equality, so "could be a distinct live child" was
  // structurally unreachable. That theory is FALSE — disproven by an existing,
  // intentional test (devswarm-retire-duplicate.test.js "P1: a distinct live
  // child (own descriptor) sharing a worktree is forwarded + LEFT, never
  // tombstoned"): two genuinely live sessions (e.g. two terminal tabs) CAN both
  // register from the exact same worktree path under different builder-ids, and
  // both must survive — same-realpath does NOT imply "not distinct". Blanket-
  // bypassing broke that legitimate case.
  //
  // The REAL bug (ground-truth SkyCrew inspection): a descriptor can linger on
  // disk for a row whose session has ALREADY DIED — descriptor files are never
  // cleaned up on session exit — so "has a descriptor" alone is not proof of a
  // live distinct child either; cmdRegister writes one for every id, making the
  // bare-descriptor gate always-true and duplicates immortal REGARDLESS of
  // liveness. The evidence that DOES distinguish a genuinely dead/stranded
  // duplicate from a real distinct live child is the SAME session-reference-
  // integrity signal (a) devswarm-liveness-select.js uses for addressing: the
  // field-observed dead row's sessionId held its LIVE SIBLING's own registry
  // id — a stale cross-reference, not a real session. A descriptor-backed
  // candidate whose sessionId aliases another id already in this SAME group
  // (any other candidate, or the survivor) is therefore NOT protected by the
  // descriptor gate; every other descriptor-backed candidate (a self-consistent
  // sessionId, exactly the P1 test's shape) keeps the original protection
  // unconditionally, for every caller, with no opt-in flag needed. CAS
  // (removeRegistryIf below) remains the final safety net regardless: a
  // candidate genuinely re-touched by a live session between the snapshot and
  // the tombstone still fails the conditional delete and is LEFT, never lost.
  const groupIds = new Set();
  for (const d0 of candidates) { if (d0 && d0.id != null) groupIds.add(String(d0.id)); }
  if (survivorId != null) groupIds.add(String(survivorId));
  function isStaleCrossReference(row) {
    if (!row) return false;
    const sid = row.sessionId != null ? String(row.sessionId) : '';
    return sid !== '' && sid !== String(row.id) && groupIds.has(sid);
  }
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
  // `anchorLeft` — the subset of `left` that survived specifically because the
  // mesh-anchor guard below refused to fold an ATTENDED canonical anchor. Kept
  // as its own Set (not a flag mutated onto the caller's row object, which is a
  // shared listRegistry() snapshot) so archiveLeftReason can report the TRUTH
  // ('mesh-anchor-attended') instead of the generic 'raced-re-register' an
  // anchor with no descriptor file would otherwise be labelled with. Every
  // non-anchor row's reason is unchanged.
  const anchorLeft = new Set();
  // canonicalMeshId spawns `git rev-parse --show-toplevel` (resolveCallerWorktree)
  // and was called once per CANDIDATE by the anchor guard below — a fold over a
  // 40-row same-worktree group paid 40 identical git spawns for one answer.
  // Memoized per worktreePath for the LIFETIME OF THIS ONE PASS only (never
  // module-scoped): a fold is a single synchronous sweep, so the resolution
  // cannot change underneath it, and a later pass still re-resolves from
  // scratch. Behaviour-preserving, including the fail-open: a THROW is cached
  // as the same `null` the catch below already treats as "cannot prove anchor".
  const meshIdCache = new Map();
  const meshIdFor = (wt) => {
    const key = String(wt);
    if (meshIdCache.has(key)) return meshIdCache.get(key);
    let v = null;
    try { v = canonicalMeshId(wt); } catch (_) { v = null; }
    meshIdCache.set(key, v);
    return v;
  };
  let forwarded = 0;
  for (const d of candidates) {
    if (!d || d.id == null || String(d.id) === String(survivorId)) continue;
    // MESH-IDENTITY-ANCHOR GUARD (Item 1 P0 fix — downstream-Primary mail
    // loss, field evidence: `primary-<hash>` cursor advancing on wake-watch
    // turns with NO `read-primary` in between, while the swept rows PROVABLY
    // still exist in that exact row's own set). A candidate whose id IS the
    // canonical meshId for its own worktree (canonicalMeshId(d.worktreePath)
    // === d.id) is the STABLE, well-known addressing anchor every
    // read-primary/inbox-count/resolveMeshTarget/send caller resolves to —
    // never whichever id happened to win survivorship in THIS one fold pass.
    // retireWorktreeDuplicates already refuses to fold FROM a meshId-keyed
    // self-register (`if (String(keepDesc.id) === String(keepMesh)) return
    // null;`, above in this file) — but that guard only protects the meshId
    // row when it is the CALLER (the survivor). It left the mirror case wide
    // open: a co-located BUILDER-ID self-register (a distinct caller sharing
    // the SAME worktree, or foldMeshDuplicates' own pickSurvivor picking a
    // builder-id row over the meshId one) walks the meshId row in here as an
    // ORDINARY candidate, and foldOne's unconditional cursor-advance (the
    // contiguous-forwarded-prefix write below, `B1(b)`) sweeps its read
    // frontier past messages that get re-addressed to a survivor id nothing
    // standard ever reads under — real, undelivered mail silently marked
    // "read" on the only partition anyone queries.
    //
    // FIX: never even attempt to fold a meshId-canonical candidate that is
    // still ATTENDED — skip both the forward loop and the cursor advance
    // entirely (loss-free direction per this fix's own mandate: when in
    // doubt, do not fold, do not advance), reporting it exactly like any
    // other protected LEFT row.
    //
    // ATTENDED, not merely meshId-shaped (NARROWING — the first cut of this
    // guard keyed on identity ALONE and was too broad). The loss it prevents
    // is "a reader is still draining this exact partition and its frontier
    // gets swept out from under it". That reader only exists when the anchor
    // row is LIVE — a live registry sessionId (isLiveSessionId: non-empty and
    // not the synthetic prefix), or an on-disk descriptor for the id (a
    // session whose registry sessionId is blank/synthetic but which still
    // addresses itself under the anchor). An UNATTENDED anchor row — the
    // store-only `primary-<hash>` spawn phantom with sessionId null and no
    // descriptor — has no reader at all, and collapsing it is precisely what
    // the EXPLICIT retire paths exist to do: cmdArchive /
    // retireArchivedWorktreeGroup, healOrphanPartitions' phantom rescue,
    // foldArchivedRegistryRows, and the foldMeshDuplicates sweep. Their
    // forward-then-tombstone is loss-free (the unread is re-addressed to the
    // survivor first, and the original rows are never deleted), so blanket-
    // blocking them stranded phantom rows projecting active forever. This
    // narrowing is also CONSISTENT with the archive contract those paths
    // already honour independently (a row with its own LIVE descriptor is
    // never tombstoned, only surfaced) — it extends that same "leave the
    // live one alone" rule to the anchor's CURSOR, which the descriptor gate
    // by itself does not cover (it runs after foldOne has already forwarded
    // and advanced).
    //
    // Fail-open: any error resolving canonicalMeshId (git spawn failure,
    // unresolvable/vanished worktree path) means "cannot prove this is the
    // canonical anchor" -> falls through to the pre-existing behaviour
    // unaffected (never a false protection from a fail-open path). The
    // liveness half fails the OTHER way on error — an unreadable descriptor
    // area is not proof of absence, but isLiveSessionId is a pure string
    // test and readDescriptorFile is already fail-soft (returns null), so a
    // null there simply means "no positive evidence of a reader".
    //
    // READER EVIDENCE (Wave 10 — the FIELD shape the two signals above miss).
    // In the real incident store the live Primary's own anchor row carries
    // sessionId `unclaimed:primary-<hash>`, which isLiveSessionId REJECTS by
    // design (SYNTHETIC_SESSION_PREFIX, :245-250 — the auto-ensure/self-register
    // mint is deliberately not "live"). So in the field the guard held on the
    // DESCRIPTOR half ALONE — and descriptor-only protection is fragile,
    // because archive paths legitimately delete a live descriptor
    // (workspaces/<id>.json) while the session behind it keeps reading. A
    // third, INDEPENDENT positive signal closes that: proof that something has
    // ACTUALLY DRAINED this partition — a store cursor > 0 (s.cursorValue),
    // or an on-disk read-path ack file at primaryCursorPath(home,id)
    // (cursors/<id>.json, the file `read-primary` acks through). Either one
    // means a reader exists (or existed and holds a frontier), and sweeping
    // that frontier forward is exactly the loss this guard exists to prevent.
    //
    // Deliberately NOT blanket: cursor 0 with no cursor file is the
    // UNATTENDED spawn-phantom shape the explicit retire paths (cmdArchive /
    // retireArchivedWorktreeGroup / foldArchivedRegistryRows / phantom
    // rescue) must still collapse — those rows never read anything, so they
    // produce no reader evidence and keep retiring unchanged.
    //
    // Fail-soft on BOTH halves: a store handle without cursorValue (the unit
    // fixtures' fake stores), a throwing cursorValue, or an unreadable cursors/
    // directory yields NO evidence — never a throw, never a false protection.
    const hasReaderEvidence = (id) => {
      try {
        if (s && typeof s.cursorValue === 'function') {
          const v = s.cursorValue(id);
          if (Number.isFinite(v) && v > 0) return true;
        }
      } catch (_) { /* no evidence from the store */ }
      try { if (inboxCursor.readCursor(primaryCursorPath(home, id)) > 0) return true; } catch (_) { /* no evidence on disk */ }
      return false;
    };
    //
    // LIVENESS HALF — `isSiblingPartitionLive`, NOT `isLiveSessionId` (carry-out
    // (a)). `isLiveSessionId` is a pure SHAPE test: non-empty and not
    // 'unclaimed:'. It says nothing about whether that session still exists, so
    // a PHANTOM anchor carrying a stale non-null sessionId (a session that
    // ended hours ago, its id never cleared from the registry row) read
    // ATTENDED forever and could never be retired by any sweep — the anchor
    // became immortal, and the phantom kept projecting ACTIVE in the roster.
    // `isSiblingPartitionLive` (companion/lib/liveness.js:459) is the SAME
    // composed predicate `siblingAckGate` (:314 in this file) already uses for
    // exactly this "is there really a reader behind this partition" question,
    // so the two cursor-safety surfaces cannot drift: fresh heartbeat -> live;
    // empty/'unclaimed:' sessionId -> not live; otherwise live unless the row
    // is provably dormant. It fails OPEN (undetermined -> live -> protected),
    // which is the loss-free direction this guard already commits to.
    // The descriptor and reader-evidence halves are UNCHANGED — they are what
    // hold the FIELD case (an 'unclaimed:' anchor whose liveness half is false
    // by design), and the FIELD CASE tests pin them independently.
    //
    // CROSS-REFERENCE NARROWING (carry-out (b)). This branch used to `continue`
    // BEFORE the `isStaleCrossReference` check below ever ran, so an anchor
    // whose sessionId is ANOTHER GROUP MEMBER'S REGISTRY ID — the proven-stale
    // shape isStaleCrossReference exists to catch, and the exact evidence
    // devswarm-liveness-select.js uses to tell a dead duplicate from a real
    // live child — was immortal too, and worse: that bogus sessionId is
    // precisely what made the liveness half true. The two protections that a
    // stale cross-reference can FORGE are therefore withdrawn for it:
    //   * liveness — the cross-referenced sessionId IS the forged signal;
    //   * descriptor — :1914/:2002 already treat a descriptor as insufficient
    //     for a stale cross-reference, so honouring it here would contradict
    //     the fold's own rule two branches down.
    // READER EVIDENCE is NOT withdrawn, and that asymmetry is the whole point:
    // it is the FIELD P0 shape (a real reader draining this exact partition),
    // it cannot be forged by a sessionId — a cursor only moves because
    // something actually read — and sweeping a live frontier is the precise
    // loss this guard exists to prevent. So a cross-referenced anchor WITH a
    // read frontier stays fully protected; one with NO reader evidence falls
    // through to the ordinary path, where isStaleCrossReference governs it
    // exactly as it governs every other row (CAS-guarded tombstone, forward
    // first — loss-free).
    let isMeshAnchor = false;
    try {
      const anchorShaped = !!(d.worktreePath && String(d.id) === String(meshIdFor(d.worktreePath)));
      if (anchorShaped) {
        const readerEvidence = hasReaderEvidence(d.id);
        if (isStaleCrossReference(d)) {
          // R11-A5 — LIVENESS RESTORED HERE AS ITS HEARTBEAT TERM ONLY;
          // DESCRIPTOR STILL WITHDRAWN.
          //
          // Carry-out (b) withdrew liveness from a stale cross-reference on
          // the reasoning "the forged sessionId is what makes liveness true".
          // That reasoning holds for `isLiveSessionId` (a pure SHAPE test on
          // the sessionId string, which a cross-reference trivially satisfies)
          // and it is right to keep that withdrawn. But it swept away a term
          // that is NOT forgeable: `hasFreshHeartbeat(d.id, ...)` is keyed on
          // the ROW'S OWN id and read off that partition's own heartbeat file,
          // so nothing sitting in the sessionId field can produce it. A
          // cross-referenced anchor that is heartbeating RIGHT NOW has a real
          // session behind it, and retiring it is the same live-frontier sweep
          // the reader-evidence half exists to prevent.
          //
          // WHY NOT THE WHOLE `isSiblingPartitionLive` COMPOSITION (verified,
          // not assumed): after its heartbeat term, that function falls back to
          // `!isDormantRow(...)`, and isDormantRow is FAIL-OPEN on absence of
          // evidence (companion/lib/liveness.js:433-438 — "no signal at all ->
          // not dormant"). A cross-referenced anchor with no heartbeat and no
          // transcript therefore reads LIVE, which would protect essentially
          // EVERY cross-referenced anchor and re-create the immortal row
          // carry-out (b) exists to kill (proven: it turns the WAVE 11 (b) test
          // above red). Its dormancy term is also the one leg a borrowed uuid
          // CAN influence. So exactly the unforgeable half is restored here,
          // and the fail-open half is not.
          //
          // The DESCRIPTOR half stays withdrawn: :1976/:2064 already treat a
          // descriptor as insufficient for a stale cross-reference, and
          // honouring it here would contradict the fold's own rule.
          let beating = false;
          try {
            beating = hasFreshHeartbeat(d.id, home, { now: opts && opts.now });
          } catch (_) { beating = false; } // unreadable heartbeat is NOT positive proof of a live reader
          isMeshAnchor = readerEvidence || beating;
        } else {
          let live = false;
          try {
            live = isSiblingPartitionLive(
              { id: d.id, worktreePath: d.worktreePath, sessionId: d.sessionId },
              home, { now: opts && opts.now }
            );
          } catch (_) { live = true; } // undetermined -> fail toward attended (loss-free), matching isSiblingPartitionLive's own posture
          isMeshAnchor = live || !!readDescriptorFile(home, d.id) || readerEvidence;
        }
      }
    } catch (_) { isMeshAnchor = false; }
    if (isMeshAnchor) { left.push(d.id); leftRows.set(String(d.id), d); anchorLeft.add(String(d.id)); continue; }
    if (dryRun) {
      // read-only classification: a store-only row WOULD be tombstoned; a
      // descriptor-backed one WOULD be left (never collapsed) — UNLESS its
      // sessionId is a proven stale cross-reference (see isStaleCrossReference
      // above), in which case it WOULD be tombstoned too (subject to the same
      // CAS the apply path uses).
      if (!isStaleCrossReference(d) && readDescriptorFile(home, d.id)) { left.push(d.id); leftRows.set(String(d.id), d); continue; }
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
      let since = 0;
      // advanceTo/sawGap (0a668d81c0c6 fix) — the cursor is a per-workspace
      // CONSUMED-COUNT into listMessages' insertion-ordered sequence
      // (devswarm-store.js:716); setting it to N asserts "rows 1..N since
      // `since` are fully handled, in order, no gaps". A non-forwardable row
      // (native-ingested mail: devswarm-ingest.js inserts it with mtype/
      // sender/recipient all NULL, so isForwardable is false) is NOT a copy
      // that safely exists elsewhere — it is real mail the row still needs —
      // so the advance may only cover the CONTIGUOUS run of forwarded-or-
      // dedup-confirmed rows starting at `since`. The first non-forwardable
      // row flips `sawGap` and permanently stops `advanceTo` from moving any
      // further, even though forwarding itself keeps running past it for any
      // later forwardable rows (forwarding is idempotent and independent of
      // the cursor). Was previously `s.messageCount(row.id)` — a raw COUNT(*)
      // over the whole partition that counts non-forwardable rows too, so it
      // swept the cursor past unforwarded native mail and silently lost it
      // (defect 0a668d81c0c6).
      let advanceTo = 0;
      let sawGap = false;
      // ---------------------------------------------------------------------
      // R13 item 11 (P0-adjacent, UNATTENDED) — DO NOT RE-FORWARD ROWS THE
      // SURVIVOR'S READER HAS ALREADY CONSUMED THROUGH THE SIBLING UNION.
      //
      // ROOT CAUSE (reproduced, not inferred): `since` below is the candidate's
      // OWN STORE CURSOR only. A LIVE twin's ack gate is closed by design
      // (siblingAckGate), so `read-primary` delivers that twin's rows to the
      // survivor's reader while deliberately leaving the twin's own cursors at
      // 0 — progress is recorded ONLY in the caller-scoped watermark (item 10).
      // The fold cannot see that watermark, so it restarts at 0 and forwards
      // the entire already-consumed backlog into the survivor as FRESH copies,
      // which the survivor's very next read then delivers a second time.
      // Measured on the repro shape (both rows live, survivor anchor-shaped):
      // watermark 20, fold forwarded 20, survivor total 1 -> 21, next
      // read-primary delivered 20 duplicates. This runs UNATTENDED — the
      // supervisor's periodic sweep (companion/devswarm-supervisor.js:658) and
      // `/anti-hall:update` (skills/update/scripts/update.js:1026) both call
      // THIS SAME `foldMeshDuplicates`, so neither needs (or has) its own path.
      //
      // FIX: forward only rows ABOVE `forwardFrom` = max of the three places
      // "this row has been consumed" can be recorded — the candidate's own two
      // cursor namespaces (item 7's MAX) and the SURVIVOR's watermark for this
      // candidate (item 10). Every row at or below it is already in the
      // survivor's reader's hands; copying it there is pure duplication.
      //
      // AND THE SKIP MUST NOT ADVANCE THE CANDIDATE'S OWN CURSOR (`sawGap`).
      // The B1(b) advance below is only sound because a forwarded row "safely
      // exists elsewhere" — in the survivor's partition. A SKIPPED row does
      // NOT: it was delivered to the survivor's READER but never copied into
      // the survivor's partition. Advancing the candidate's cursor past it
      // would hide it from the candidate's OWN reader, which is real mail loss.
      // Skipped rows sit at the FRONT of the window, so this simply means the
      // cursor does not move on a pass that only skipped — exactly right.
      let forwardFrom = 0;
      try {
        forwardFrom = Math.max(
          siblingBaseCursor(s, home, row.id),            // max(store cursor, cursors/<id>.json)
          readSiblingSeenCursor(home, survivorId, row.id) // the survivor's own watermark for this candidate
        );
      } catch (_) { forwardFrom = 0; } // fail-open: forward everything, the pre-fix behaviour
      try {
        since = s.cursorValue(row.id);
        advanceTo = since;
        let pos = since;
        for (const m of s.listMessages(row.id, { sinceCursor: since })) {
          pos += 1;
          // ALREADY DELIVERED to the survivor's reader (see forwardFrom above):
          // never copy it again, and never let the cursor advance past it.
          if (pos <= forwardFrom) { sawGap = true; continue; }
          if (!isForwardable(m)) { sawGap = true; continue; } // #67: forward only a real actionable direct — skips broadcast/heartbeat AND stale native poke/hash-mirror rows (mtype/sender null); also stops the cursor advance below, since this row's mail has no other home
          // FORWARD: same ONE shared MESH_ROW_COPY_FIELDS table as the verbatim
          // re-home site (see meshRowCopy). The overrides re-address the copy to the
          // survivor partition; `type:'direct'` is pinned (not m.mtype) because only
          // a direct can reach here at all — isForwardable already filtered the rest —
          // and urgency keeps its pre-existing empty-string->'normal' normalization.
          // `hash` is absent by design (recomputed below from the NEW fields) and so
          // is `isHeartbeat` (a heartbeat is never forwardable).
          const fields = meshRowCopy(m, 'message', {
            to: survivorId, type: 'direct', urgency: m.urgency || 'normal',
            // R13 item 11 (second half) — STAMP origHash, exactly as the
            // archived-forward site already does (forwardArchivedOrphanUnread,
            // ~:1370). The forward RE-ADDRESSES the row, so the copy's own hash
            // necessarily differs from the original's and no reader can match
            // it against a message it already consumed. C2's exact
            // cross-partition dedup (`foldSiblingGapRows`, via
            // `forwardedOrigHashOf`) is keyed on origHash — measured on the
            // repro, fold forwards carried it on 0 of 20 rows, so that dedup
            // could not fire for them at all. `m.origHash || m.hash`: a chain
            // of forwards keeps pointing at the ROOT original, never at the
            // intermediate copy. This is the belt to forwardFrom's braces —
            // forwardFrom stops the copy being made, origHash stops any copy
            // that IS made (an older build's, a different survivor's) from
            // being delivered twice.
            origHash: (m.origHash != null ? m.origHash : m.hash) || null,
          });
          const hash = store.meshMessageHash(fields);
          const r = store.appendMeshMessage(s, Object.assign({}, fields, { hash }));
          if (r && r.inserted) forwarded++;
          if (!sawGap) advanceTo = pos; // still a contiguous forwarded prefix — safe to advance through this row
        }
      } catch (_) { forwardOk = false; }
      if (!forwardOk) return { outcome: 'forward-failed' };
      // B1(b) fix — advance the CANDIDATE's OWN cursor now that the try block
      // above completed with NO exception (every appendMeshMessage call
      // either inserted the row into the survivor or hit the hash-dedupe
      // OR-IGNORE path because it was already forwarded by a prior pass —
      // both are "safely delivered", never "lost"). This closes the second,
      // independent defect: a candidate this pass classifies `left` (a live
      // descriptor it correctly never tombstones) previously kept its
      // pre-fold cursor forever, so its already-forwarded backlog rendered as
      // "N unread / not draining" indefinitely even though every message had
      // already reached the survivor. Advancing a LIVE child's cursor on its
      // behalf, from a sweep it never requested, IS a sound primitive here —
      // but ONLY up to `advanceTo`: every row up to that point is either
      // forwarded (verbatim, in the survivor's partition — reachable there)
      // or dedup-confirmed already forwarded by a prior pass, so marking it
      // read on the losing partition does not lose access to it. Gated on
      // COMPLETE success only — the `!forwardOk` branch above already
      // returned before reaching here, so a partial/failed forward (an
      // exception mid-loop, e.g. a store write that throws after some but
      // not all rows were appended) NEVER runs this: the cursor stays
      // exactly where it was, so the next fold pass re-attempts the whole
      // unread range and the already-forwarded rows are re-forwarded
      // idempotently (hash dedupe) rather than silently dropped off the read
      // frontier. `since`/`advanceTo` are computed from the SAME listMessages
      // read used for forwarding, so a message that arrives concurrently
      // mid-fold is simply left unread for the next pass, never swallowed.
      //
      // P0 LOCKSTEP (v0.90.1): advance the READ-PATH ack file
      // (`cursors/<id>.json`) to the SAME value. These are two namespaces for
      // one fact ("how far this partition is consumed"), and advancing only the
      // store side is exactly what let `inbox count` (store-sized) report 0
      // while `read-primary` (json-sized) re-delivered the whole already-
      // forwarded backlog on every read. `ackTo` is monotonic, so this can only
      // ever raise the file toward the store value, never rewind it.
      try {
        if (advanceTo > since) {
          s.setCursor(row.id, advanceTo);
          try { inboxCursor.ackTo(primaryCursorPath(home, row.id), advanceTo); } catch (_) { /* fail-soft: reconcile re-converges the pair */ }
        }
      } catch (_) { /* best-effort bookkeeping; never blocks the fold itself */ }
      // `row` here is whatever foldOne was called with — the in-lock re-read `cur`
      // when locked, the pre-lock candidate `d` when not — so a caller keying its
      // reported reason off this row (leftRows, below) reports what THIS pass
      // actually judged, not a possibly-stale pre-lock snapshot.
      if (!isStaleCrossReference(row) && readDescriptorFile(home, row.id)) return { outcome: 'left', row };
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
  return { retired, left, forwardFailed, forwarded, skipped, leftRows, anchorLeft };
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
    const pick = pickSurvivor(s, { rows: drainableRows }, home);
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
// `isAnchor` (Wave 10) — true when foldGroupIntoSurvivor's mesh-anchor guard is
// what kept this row (r.anchorLeft). That row was never even OFFERED to the
// tombstone, so 'raced-re-register' (which asserts a conditional delete was
// refused) is a FALSE report for it — and it is the reason an anchor protected
// only by reader evidence (no descriptor file) would otherwise get. Checked
// FIRST because it is the most specific fact available; every other row's
// reason is computed exactly as before.
function archiveLeftReason(home, id, row, isAnchor) {
  if (isAnchor) return 'mesh-anchor-attended';
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
      out.left.push({ id: String(x), reason: archiveLeftReason(home, x, (r.leftRows && r.leftRows.get(String(x))) || rowOf.get(String(x)), !!(r.anchorLeft && r.anchorLeft.has(String(x)))) });
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

// groupRegistryByMeshId(registry, home) -> Map<meshId, {meshId, ids[], rows[], liveRows}>.
// The ONE grouping implementation shared by cmdDiagnose (split detection) AND
// foldMeshDuplicates (canonical fold) — grouping key is canonicalMeshId so both
// see subdir-splits folded onto their toplevel identically.
// D11-A: `liveRows` is now computed via isRoutingLiveRow (heartbeat-freshness +
// harness-session-dormancy, see that function's header) instead of the bare
// isLiveSessionId(sessionId) shape test — a real-but-long-dead sessionId (a
// crashed sibling whose registry row was never cleaned up) no longer counts
// toward `liveRows`, so meshTargets' kind/split/deadSplit classification
// (computeDiagnosis, below) reflects who is ACTUALLY draining a partition, not
// merely who once registered one. `home` is optional (omitting it only
// disables the heartbeat-credit half; the descriptor-existence fallback and
// shape checks still run) — every existing caller already has `home` in scope.
function groupRegistryByMeshId(registry, home) {
  const byMesh = new Map();
  for (const d of registry) {
    if (!d || !d.worktreePath) continue;
    const meshId = canonicalMeshId(d.worktreePath);
    if (!meshId) continue;
    let g = byMesh.get(meshId);
    if (!g) { g = { meshId, ids: [], rows: [], liveRows: 0 }; byMesh.set(meshId, g); }
    g.ids.push(d.id);
    g.rows.push(d);
    if (isRoutingLiveRow(d, home)) g.liveRows++;
  }
  return byMesh;
}

// pickSurvivor(s, group, home) — the SAME freshest-LIVE selection resolveMeshTarget
// uses (devswarm-liveness-select.js's pickFreshestLive: session-reference integrity,
// drain activity, session-authored heartbeat, THEN updatedAt/cursor recency),
// generalized to a canonical group's OWN rows (which include subdir-split rows
// resolveMeshTarget's plain-hash match would miss). The survivor is the partition a
// live session actually drains. `home` is optional (enables the heartbeat-credit
// signal only). D11-A: the LIVE-candidate gate pickFreshestLive applies is now
// isRoutingLiveRowStrict (via opts.isLive), not the bare isLiveSessionId shape
// test — see that function's header for why (a real-but-dormant sessionId no
// longer wins a `send`/fold target over a genuinely live sibling; the STRICT,
// no-descriptor-fallback variant, not isRoutingLiveRow, is used here — a
// dead store-only row's lingering descriptor must never win a survivor pick).
function pickSurvivor(s, group, home) {
  return livenessSelect.pickFreshestLive(group.rows, {
    storeHandle: s, home,
    isLive: (row) => isRoutingLiveRowStrict(row, home),
  });
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
// GHOST-ROW AGEING (defect 76891c157288, P2).
//
// A "ghost" is a registry row that has NEVER been attended and has not been
// touched in a long time. Every leg is a POSITIVE absence-of-attendance proof
// read off disk, and ALL of them must hold — this is deliberately much stricter
// than foldGroupIntoSurvivor's own unattended test, because unlike that test
// this one runs on a group where NO row looks live and so has no live sibling
// to cross-check against:
//   1. sessionId is null/empty. NOT `unclaimed:<id>` — that is the live
//      Primary's own self-register mint (the FIELD shape this must never touch).
//   2. no workspaces/<id>.json descriptor.
//   3. no heartbeats/<id>.json — nothing has ever reported as this id.
//   4. store cursor 0 AND no cursors/<id>.json read-path ack file: nothing has
//      ever DRAINED this partition (the unforgeable reader-evidence signal
//      foldGroupIntoSurvivor's anchor guard already relies on).
//   5. `updatedAt` older than the age bar. Legs 1-4 can all be true of a row
//      registered SECONDS ago by a spawn that has not launched yet, so the age
//      bar is what separates "never attended" from "not attended YET".
//
// A row whose updatedAt is missing/non-finite is NOT aged out (unknown age is
// not old age). Every read is fail-soft, and every failure resolves to "not a
// ghost" — this function can only ever REFUSE to nominate a row.
const GHOST_ROW_MAX_AGE_H_DEFAULT = 72;
function ghostRowMaxAgeMs(env) {
  const raw = env && env.ANTIHALL_DEVSWARM_GHOST_ROW_MAX_AGE_H;
  const n = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
  const hours = Number.isFinite(n) && n > 0 ? n : GHOST_ROW_MAX_AGE_H_DEFAULT;
  return hours * 60 * 60 * 1000;
}
function ghostRegistryRows(s, home, rows, ctx) {
  const c = ctx || {};
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  const maxAgeMs = ghostRowMaxAgeMs(c.env || process.env);
  const out = [];
  for (const d of rows || []) {
    try {
      if (!d || d.id == null) continue;
      const rid = String(d.id);
      if (!isSafeId(rid)) continue;
      // (1) sessionId genuinely absent — never an `unclaimed:` mint
      const sid = d.sessionId != null ? String(d.sessionId) : '';
      if (sid !== '') continue;
      // (2) no descriptor
      if (readDescriptorFile(home, rid)) continue;
      // (3) no heartbeat ever
      let beat = false;
      try { beat = fs.existsSync(heartbeatPathFor(rid, home)); } catch (_) { beat = true; } // unreadable -> assume attended
      if (beat) continue;
      // (4) no reader evidence in EITHER cursor namespace
      let drained = true;
      try { drained = siblingBaseCursor(s, home, rid) > 0; } catch (_) { drained = true; }
      if (drained) continue;
      try { if (fs.existsSync(primaryCursorPath(home, rid))) continue; } catch (_) { continue; }
      // (5) aged past the bar; unknown age is never old age
      const upd = Number(d.updatedAt);
      if (!Number.isFinite(upd) || upd <= 0) continue;
      if ((now - upd) < maxAgeMs) continue;
      out.push(d);
    } catch (_) { /* fail-soft: not a ghost */ }
  }
  return out;
}

function foldMeshDuplicates(home, ctx) {
  const c = ctx || {};
  const dryRun = !!c.dryRun;
  try {
    // ctx.repoKey (spec item 5c: update-time self-heal across EVERY store, not
    // only the one the caller's cwd happens to resolve to right now) — an
    // explicit override for foldMeshDuplicatesAllStores below to fold a named
    // store directly, bypassing cwd/git resolution entirely. Absent (the
    // default, every pre-existing call site) falls back to the original
    // cwd-derived behavior, byte-identical.
    const repoKey = typeof c.repoKey === 'string' && c.repoKey ? c.repoKey : repoKeyForCwd(c);
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
    const needsAttention = []; // HAZARD 1 fix: zero-live groups refused (never folded by id-sort)
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
      const byMesh = groupRegistryByMeshId(s.listRegistry(), home);
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
          // HAZARD 1 (live data-loss): a ZERO-LIVE group has no live session
          // draining ANY row, so pickFreshestLive's own fallback ("first
          // candidate") degrades to id-sort order — an accident of
          // listRegistry()'s enumeration, not a signal of which row is
          // actually being drained. Forwarding backlog INTO an id-sort
          // "survivor" can move mail OUT of a row a Primary is mid-drain on
          // (its sessionId already went stale/dead between drains) and INTO
          // a row nobody reads — the opposite of this fold's intent, and it
          // makes stranded mail WORSE, not better. Refuse to fold this group
          // at all (no forward, no tombstone) and surface it for operator
          // attention instead — never silently pick by registry order.
          if (!livenessSelect.hasLiveCandidate(rows)) {
            // DEFECT 76891c157288 (P2) — GHOST-ROW AGEING. This refusal is the
            // ROOT CAUSE of the field shape: a `sessionId: null` row sharing the
            // live Primary's worktreePath sits in a group whose ONLY other
            // member is the Primary's own anchor row, and that anchor carries
            // `unclaimed:primary-<hash>`, which isLiveSessionId rejects BY
            // DESIGN (SYNTHETIC_SESSION_PREFIX). So the group has zero "live"
            // rows, this branch refuses it wholesale, and the ghost is immortal
            // — projecting active in every roster and diagnose forever.
            //
            // The refusal itself is right for its own hazard (id-sort survivor
            // selection moving mail into a row nobody reads). It is only wrong
            // for a group where survivorship is NOT a judgement call, so that is
            // the ONLY case carved out here:
            //   * every ghost is provably unattended AND AGED (ghostRegistryRows
            //     — sessionId null/empty, no descriptor, no heartbeat, cursor 0
            //     in BOTH namespaces, no read-path ack file, and untouched for
            //     longer than ANTIHALL_DEVSWARM_GHOST_ROW_MAX_AGE_H, default
            //     72 h), and
            //   * exactly ONE non-ghost row remains, so the survivor is forced
            //     by the group's own shape and no ranking is involved.
            // The retirement itself runs through the EXISTING fold path
            // (foldGroupIntoSurvivor's unattended branch): forward-then-tombstone,
            // CAS-guarded, no new deletion primitive and no message ever dropped.
            // Attended anchors are untouched — the FIELD shape (`unclaimed:` +
            // cursor > 0 + descriptor) fails ghostRegistryRows on three separate
            // legs, and foldGroupIntoSurvivor's own anchor guard refuses it again.
            const ghosts = ghostRegistryRows(s, home, rows, c);
            const nonGhosts = rows.filter((d) => !ghosts.some((x) => String(x.id) === String(d.id)));
            if (ghosts.length > 0 && nonGhosts.length === 1) {
              const r = foldGroupIntoSurvivor(s, home, nonGhosts[0].id, ghosts, { dryRun });
              forwarded += r.forwarded;
              for (const x of r.retired) retired.push(x);
              for (const x of r.left) left.push(x);
              for (const x of r.forwardFailed) forwardFailed.push(x);
              if (r.retired.length || r.left.length || r.forwardFailed.length) folded++;
              continue;
            }
            needsAttention.push({ meshId: g.meshId, ids: rows.map((d) => d.id) });
            continue;
          }
          const survivor = pickSurvivor(s, { rows }, home);
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
    if (needsAttention.length) out.needsAttention = needsAttention;
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

// foldMeshDuplicatesAllStores(home, ctx) — spec item 5c / [E] UPDATE-TIME
// SELF-HEAL: foldMeshDuplicates above only folds ONE project's store — the one
// `ctx.cwd` (or process.cwd()) happens to resolve to right now. An update/
// doctor run from project A can never reach an ALREADY-SPLIT registry sitting
// in project B's store, so a machine with several DevSwarm projects would only
// ever self-heal the one the operator happened to be standing in when they
// last updated — exactly the gap the field evidence (a stray dead partition
// discovered by direct store inspection, not by running update from that
// project) surfaced. This sweeps EVERY store this machine has EVER opened
// (store.listStoreHashes(home) — the same enumeration healRegistryPostUpdate
// already uses for its own cross-store sweep) and folds each one directly by
// its stored hash, bypassing cwd/git resolution entirely via foldMeshDuplicates'
// `ctx.repoKey` override. Same guarantees as foldMeshDuplicates itself per
// store: idempotent, fail-open (a single store's failure is recorded and
// skipped, never aborts the sweep or throws out of this function), NO-DELETE
// (forward-before-tombstone). Bounded/throttled by the CALLER (update.js /
// doctor-repair.js), matching the project's heavy-scan convention — this
// function itself does no throttling, it only enumerates+applies.
// Returns { ok, stores, retired, forwarded, folded, errors, results[] }.
function foldMeshDuplicatesAllStores(home, ctx) {
  const c = ctx || {};
  let hashes = [];
  try { hashes = store.listStoreHashes(home) || []; } catch (_) { hashes = []; }
  let retired = 0, forwarded = 0, folded = 0, errors = 0;
  const results = [];
  for (const repoKey of hashes) {
    let r = null;
    try {
      r = foldMeshDuplicates(home, Object.assign({}, c, { repoKey }));
    } catch (e) {
      r = { ok: false, error: String(e && e.message || e), retired: [], forwarded: 0, folded: 0 };
    }
    if (!r) continue;
    if (r.ok === false) { errors++; results.push({ repoKey, ok: false, error: r.error }); continue; }
    const n = Array.isArray(r.retired) ? r.retired.length : 0;
    retired += n;
    forwarded += r.forwarded || 0;
    folded += r.folded || 0;
    if (n || r.forwarded) results.push({ repoKey, ok: true, retired: n, forwarded: r.forwarded || 0, folded: r.folded || 0 });
  }
  return { ok: true, stores: hashes.length, retired, forwarded, folded, errors, results };
}

// reconcileOrphanCursor(home, s, id, desc, dryRun) — MIN-only reconciliation of the
// THREE independent cursor namespaces a partition can carry: the durable Primary/
// read-path ack file (primaryCursorPath, `cursors/<id>.json`), the descriptor's own
// inbox-cursor file (desc.cursorPath, `cursors/<id>.cursor` by convention), and the
// mesh store's own cursor row (s.cursorValue/s.setCursor). All three are read via
// inboxCursor.readCursor / s.cursorValue, which already fail-safe to 0 on an absent/
// unreadable file — so a namespace that was never touched contributes 0, never null,
// and 0 can never be lowered further. The reconciled value is the MIN of whichever
// namespaces are present: taking the MAX would mark a message "read" in a namespace
// whose own reader never actually saw it (silent unread-loss, the exact forbidden
// side effect this repo's owner rule bans). A namespace is only rewritten when it is
// STRICTLY ABOVE the computed min — an already-min namespace is left untouched, so
// the common case (all three already agree) performs zero writes. dryRun classifies
// without writing (`changed` reports whether a write WOULD occur).
// P0 CORRECTION (v0.90.1) — THE DESCRIPTOR'S NDJSON CURSOR IS NOT IN THIS SET.
//
// The header above treats all three as "the same fact in three namespaces".
// Two of them are: `cursors/<id>.json` and the store cursor both count STORE
// ROWS for partition `id`. The third does not — `desc.cursorPath` counts LINES
// of the descriptor's durable NDJSON inbox, an entirely different sequence
// (populated only by `inbox pull` draining the native queue). Folding it into
// one MIN meant a converged partition (json 606 / store 606) with an untouched
// NDJSON channel (0 lines consumed, because it has no lines) computed min 0 and
// REWOUND both store-side cursors to 0 — after which `read-primary` re-delivered
// all 606 rows. That is the confirmed mechanism behind the field report
// (scratchpad repro p0/repro2.js: deregister the twin, run healOrphanPartitions,
// watch 606/606 collapse to 0/0).
//
// The two STORE-SIDE namespaces are still reconciled against each other (they
// genuinely must agree, and MIN is still the safe direction there). The NDJSON
// cursor is reconciled only against ITSELF — i.e. left alone; it has no peer in
// this function. A file cursor of 0 alongside non-zero store-side cursors is
// therefore no longer evidence of anything, and the explicit guard below refuses
// to rewind on that shape even if a future change reintroduces the coupling.
function reconcileOrphanCursor(home, s, id, desc, dryRun) {
  let jsonCursor = 0, fileCursor = 0, storeCursor = 0;
  try { jsonCursor = inboxCursor.readCursor(primaryCursorPath(home, id)); } catch (_) { jsonCursor = 0; }
  if (desc && desc.cursorPath) {
    try { fileCursor = inboxCursor.readCursor(desc.cursorPath); } catch (_) { fileCursor = 0; }
  }
  try { storeCursor = s.cursorValue(id); } catch (_) { storeCursor = 0; }
  // MIN over the STORE-SIDE pair only — never the NDJSON line cursor.
  const min = Math.min(jsonCursor, storeCursor);
  // Belt-and-braces: an untouched NDJSON channel must never drag a converged
  // store-side pair back to zero (the exact field regression above). Scoped to
  // `min === 0` on purpose — a genuine store-side disagreement at a NON-zero
  // min (e.g. json 100 vs store 606) is still a real reconcile and still runs.
  if (fileCursor === 0 && (jsonCursor > 0 || storeCursor > 0) && min === 0) {
    return { changed: false, min: 0, skipped: 'ndjson-cursor-not-a-store-cursor' };
  }
  let changed = false;
  // C2 fix: ackTo() is monotonic by default (guards against unlocked-drain
  // races elsewhere) — this reconciliation is the ONE proven legitimate
  // exception (MIN-only by design, may need to lower a namespace stuck above
  // the others), so it opts in explicitly to keep its pre-fix behavior.
  if (jsonCursor > min) { if (!dryRun) { try { inboxCursor.ackTo(primaryCursorPath(home, id), min, undefined, undefined, { allowRewind: true }); } catch (_) {} } changed = true; }
  if (storeCursor > min) { if (!dryRun) { try { s.setCursor(id, min); } catch (_) {} } changed = true; }
  return { changed, min };
}

// healOrphanPartitions(home, ctx) — self-heal for a partition that has messages but
// NO registry row: structurally invisible to every fold path (foldMeshDuplicates
// groups s.listRegistry() — an unregistered id is never a candidate, never a
// survivor, never forwarded), so its messages are permanently unreachable-but-
// undeleted. deriveSummary's `orphans[]` is a READ-ONLY detector for exactly this
// shape (listWorkspaceIds() − registry ids − BROADCAST_PARTITION_ID); this is the
// heal.
//
// For each orphan id:
//   - no descriptor file, in EITHER workspaces/ or archived/ (resolveOrphanDescriptor
//     tries both — see FIX A note there) -> UNHEALABLE, detect-and-report only. No
//     worktree, no family, no provable owner — adopting it would INVENT an
//     identity. Zero writes for this id.
//   - a descriptor -> familyKey = canonicalMeshId(desc.worktreePath) (the SAME
//     helper foldMeshDuplicates/groupRegistryByMeshId use — no new key derivation).
//       - an ARCHIVED counterpart exists (hasArchivedCounterpart) -> NEVER
//         re-adopt (it was deliberately retired — re-registering it would recreate
//         the row foldArchivedRegistryRows exists to tombstone). Policy:
//           - unread == 0 -> ARCHIVED-DRAINED. Nothing to heal; NOT unhealable.
//           - unread > 0, no live family / no live survivor -> UNHEALABLE
//             (nothing to forward into).
//           - unread > 0, a live survivor exists -> FORWARD-ONLY (never adopts)
//             via forwardArchivedOrphanUnread: provenance-prefixed, age-capped
//             (archiveForwardMaxAgeMs — default 30d, ANTIHALL_DEVSWARM_ARCHIVE_
//             FORWARD_MAX_AGE_DAYS overrides). Rows past the cap are skipped
//             (never forwarded); if EVERY unread row is past the cap the id
//             classifies ARCHIVED-STALE (detect-only, zero writes) instead of
//             forwarded-only. The source row is always LEFT in place (it was
//             never in the registry to begin with — nothing to tombstone).
//       - otherwise -> ADOPT: s.upsertRegistry(...) under withIdLock(id), purely
//         additive (makes the id addressable by `send` and visible to future
//         folds). No family group -> done. A family group exists -> immediately
//         foldGroupIntoSurvivor the newly-adopted row into pickSurvivor(group)'s
//         survivor, forwarding its unread (the row is left in place, same
//         descriptor-present reasoning as above).
// Cursor reconciliation (reconcileOrphanCursor, MIN-only, never raises a cursor) is
// applied to every id that carries a descriptor, regardless of outcome.
//
// NO DELETE: only s.upsertRegistry (additive) and appendMeshRow (append-only, via
// foldGroupIntoSurvivor's forward or forwardArchivedOrphanUnread) ever write. No
// removeRegistryIf in this path, and archived ids are NEVER upserted.
// FAIL-OPEN: every per-id body is try/catch'd into `errors`; a lock-busy id is
// `skipped` and retried next pass. IDEMPOTENT: a re-run finds the adopted id in
// listRegistry() (no longer an orphan) and does nothing; a re-forward recomputes
// the same meshMessageHash and appendMeshRow dedups it (inserted:false); a MIN
// reconcile of already-equal cursors is a no-op.
// Returns { ok, scope:'store', repoKey, adopted, forwarded, unhealable,
//   archivedDrained, archivedStale, skipped, errors, detail }.
function healOrphanPartitions(home, ctx) {
  const c = ctx || {};
  const dryRun = !!c.dryRun;
  // scope — this call heals exactly ONE store (see healOrphanPartitionsAllStores
  // for the cross-store sweep); surfaced so a caller/printer never has to guess
  // which of the two different "orphan" counts (this store vs every store) it is
  // looking at (FIX C).
  const out = {
    ok: true, scope: 'store', adopted: 0, forwarded: 0, unhealable: 0,
    archivedDrained: 0, archivedStale: 0, skipped: 0, errors: 0, detail: [],
  };
  try {
    const repoKey = typeof c.repoKey === 'string' && c.repoKey ? c.repoKey : repoKeyForCwd(c);
    out.repoKey = repoKey || null;
    // NEVER open/create the shared store just to look for orphans — same posture
    // as foldMeshDuplicates.
    if (!repoKey) return out;
    let storeExists = false;
    try { storeExists = fs.existsSync(store.storeDirForHash(home, repoKey)); } catch (_) { storeExists = false; }
    if (!storeExists) return out;
    const s = store.openStore({ home, hash: repoKey, backend: c.backend, env: c.env });
    let anyWrite = false;
    try {
      // A store whose enumeration itself throws (corrupt/unreadable) is a whole-
      // store failure, not "no orphans" — counted in `errors` (fail-open per this
      // store, distinguishable from a clean zero-orphan store) rather than
      // silently swallowed to an empty list, which would misreport a real fault
      // as "nothing to heal".
      let allIds;
      try { allIds = typeof s.listWorkspaceIds === 'function' ? s.listWorkspaceIds() : []; }
      catch (e) {
        out.errors++;
        out.detail.push({ action: 'error', reason: 'listWorkspaceIds raised: ' + String(e && e.message || e) });
        return out;
      }
      const registryIds = new Set((s.listRegistry() || []).map((d) => String(d.id)));
      const orphanIds = [];
      for (const raw of allIds) {
        const id = String(raw);
        if (id === store.BROADCAST_PARTITION_ID) continue;
        if (registryIds.has(id)) continue;
        if (!isSafeId(id)) continue;
        orphanIds.push(id);
      }
      // BUDGET FIX (field-measured: 75/242 orphans across this machine's stores
      // are permanently no-descriptor-anywhere — "unhealable, forever", every
      // single pass, with no remediation path — see update.js's
      // healOrphanPartitionsPostUpdate doc). Resolve every orphan's descriptor
      // ONCE up front (same resolveOrphanDescriptor call the loop below used to
      // make inline — no extra I/O), then process ids that resolved to a REAL
      // descriptor (adopt/forward — the actual work) BEFORE the no-descriptor
      // bucket. This never skips a real descriptor's resolution (a reappearing
      // descriptor must still be adopted next pass — NO persistent blacklist/
      // tombstone), it only reorders so real work is never starved by a store
      // whose orphans are mostly unhealable, and lets an optional ctx.deadline
      // (set by update.js's throttled sweep; unset for direct/CLI calls, so
      // those see NO behavior change) cut the no-descriptor bucket off in O(1)
      // once the outer budget is spent, instead of paying per-id cost for a
      // class of ids that can never produce a write anyway.
      const resolvedById = new Map();
      const withDescriptorIds = [];
      const noDescriptorIds = [];
      for (const id of orphanIds) {
        let resolved;
        try { resolved = resolveOrphanDescriptor(home, id); }
        catch (e) { resolved = { descriptor: null, source: null, resolveError: String(e && e.message || e) }; }
        resolvedById.set(id, resolved);
        if (resolved.descriptor) withDescriptorIds.push(id); else noDescriptorIds.push(id);
      }
      for (const id of withDescriptorIds) {
        try {
          // FIX A: try the LIVE descriptor first, then fall back to the ARCHIVED
          // one — readDescriptorFile alone (workspaces/<id>.json only) made the
          // archived branch below effectively dead code (see
          // resolveOrphanDescriptor's comment for the measured evidence). Reused
          // from the up-front resolve pass above — id is only in this bucket
          // because it already resolved to a truthy descriptor.
          const resolved = resolvedById.get(id);
          const desc = resolved.descriptor;
          if (!desc) {
            out.unhealable++;
            out.detail.push({ id, action: 'unhealable', reason: 'no-descriptor' });
            continue; // ABSOLUTE: no write of any kind for an id with no descriptor
          }
          const familyKey = desc.worktreePath ? canonicalMeshId(desc.worktreePath) : null;
          const byMesh = groupRegistryByMeshId(s.listRegistry(), home);
          const group = familyKey ? byMesh.get(familyKey) : null;
          const archived = hasArchivedCounterpart(home, id);
          // CROSS-STORE GUARD (reuses descriptorFreshRepoKey — the SAME identity
          // check rehomeMiskeyedRow/healRegistry use): the descriptor's real
          // structural home may be a DIFFERENT store than the one currently being
          // healed (e.g. a stray message row left behind in the WRONG store after
          // healRegistry rehomes its registry row elsewhere — messages are never
          // deleted, so the old store keeps a message-only, now-orphaned trace).
          // ADOPTING it here would re-create the exact mis-keyed registry row
          // healRegistry exists to fix, flip-flopping the two migrations against
          // each other. Only the ADOPT path is gated — forward-only (the archived
          // branch) never creates a new registry row, so it carries no such risk.
          const freshRepoKey = descriptorFreshRepoKey(desc);
          const wrongStore = !!(freshRepoKey && repoKey && freshRepoKey !== repoKey);

          if (archived) {
            // FIX B (decided policy): an archived id is NEVER re-adopted (that
            // would recreate the row foldArchivedRegistryRows exists to tombstone
            // — the same cross-migration flip-flop this file already guards
            // against elsewhere). Its unread is FORWARD-ONLY into the identity
            // family's live survivor, subject to the age cap; drained rows
            // (unread:0) classify as archived-drained, NOT unhealable — they are
            // not something to heal, and lumping them into `unhealable` was
            // measured to be the single largest contributor to an alarming count
            // (61 of ~123 orphans on this machine) that had nothing wrong with it.
            let total = 0;
            let cursor = 0;
            try { total = s.messageCount(id); } catch (_) { total = 0; }
            try { cursor = s.cursorValue(id); } catch (_) { cursor = 0; }
            const unread = Math.max(0, total - cursor);
            if (unread === 0) {
              out.archivedDrained++;
              out.detail.push({ id, action: 'archived-drained' });
            } else if (!group || !group.rows.length) {
              out.unhealable++;
              out.detail.push({ id, action: 'unhealable', reason: 'archived-no-family' });
            } else {
              const survivor = pickSurvivor(s, group, home);
              if (!survivor || survivor.id == null) {
                out.unhealable++;
                out.detail.push({ id, action: 'unhealable', reason: 'archived-no-survivor' });
              } else if (dryRun) {
                // classify without writing: peek at the unread rows to tell "would
                // forward" apart from "every unread row is past the age cap" —
                // the same distinction the apply path below makes.
                const maxAgeMs = archiveForwardMaxAgeMs(c.env);
                const now = Number.isFinite(c.now) ? c.now : Date.now();
                let peekRows = [];
                try { peekRows = s.listMessages(id, { sinceCursor: cursor }); } catch (_) { peekRows = []; }
                const forwardableRows = peekRows.filter(isForwardable);
                const freshRows = forwardableRows.filter((m) => {
                  const ts = Number(m.ts);
                  return !(Number.isFinite(ts) && (now - ts) > maxAgeMs);
                });
                if (forwardableRows.length && !freshRows.length) {
                  out.archivedStale++;
                  out.detail.push({ id, action: 'archived-stale', survivor: survivor.id, staleCount: forwardableRows.length });
                } else {
                  out.detail.push({ id, action: 'would-forward', survivor: survivor.id });
                }
              } else {
                const maxAgeMs = archiveForwardMaxAgeMs(c.env);
                const fwd = forwardArchivedOrphanUnread(s, id, survivor.id, { maxAgeMs, now: c.now });
                out.forwarded += fwd.forwarded;
                if (fwd.forwarded) anyWrite = true;
                if (!fwd.forwarded && fwd.stale) {
                  // every unread row was past the age cap: detect-only, zero writes.
                  out.archivedStale++;
                  out.detail.push({ id, action: 'archived-stale', survivor: survivor.id, staleCount: fwd.stale });
                } else {
                  out.detail.push({ id, action: 'forwarded-only', survivor: survivor.id, forwarded: fwd.forwarded, stale: fwd.stale });
                }
              }
            }
          } else if (wrongStore) {
            out.unhealable++;
            out.detail.push({ id, action: 'unhealable', reason: 'wrong-store', freshRepoKey });
          } else if (dryRun) {
            out.adopted++;
            out.detail.push({ id, action: 'would-adopt', hasFamily: !!(group && group.rows.length) });
          } else {
            const lockRes = withIdLock(id, home, () => {
              const ok = s.upsertRegistry({
                id, worktreePath: desc.worktreePath, sessionId: desc.sessionId,
                inboxPath: desc.inboxPath, cursorPath: desc.cursorPath,
              });
              return { ok };
            });
            if (lockRes && lockRes.lockBusy) {
              out.skipped++;
              out.detail.push({ id, action: 'skipped', reason: 'lock-busy' });
            } else if (!lockRes || lockRes.ok === false) {
              out.errors++;
              out.detail.push({ id, action: 'error', reason: 'adopt-failed' });
            } else {
              out.adopted++;
              anyWrite = true;
              if (group && group.rows.length) {
                const survivor = pickSurvivor(s, group, home);
                if (survivor && survivor.id != null) {
                  const adoptedRow = { id, worktreePath: desc.worktreePath, sessionId: desc.sessionId };
                  const r = foldGroupIntoSurvivor(s, home, survivor.id, [adoptedRow], { lockCandidates: true });
                  out.forwarded += r.forwarded;
                  out.detail.push({ id, action: 'adopted', survivor: survivor.id, forwarded: r.forwarded });
                } else {
                  out.detail.push({ id, action: 'adopted', reason: 'no-live-survivor' });
                }
              } else {
                out.detail.push({ id, action: 'adopted' });
              }
            }
          }

          const rc = reconcileOrphanCursor(home, s, id, desc, dryRun);
          if (rc.changed && !dryRun) anyWrite = true;
        } catch (e) {
          out.errors++;
          out.detail.push({ id, action: 'error', error: String(e && e.message || e) });
        }
      }
      // No-descriptor-anywhere bucket (the "unhealable, forever" class): zero
      // writes either way, so once ctx.deadline (if any) is already spent this
      // classifies them ALL in O(1) instead of O(n) per-id work that could
      // never have produced a write. deadlineHit is false whenever ctx.deadline
      // is unset (direct/CLI calls keep today's exact behavior — every id
      // classified every time) or hasn't passed yet. Skipped ids are counted in
      // `skipped`, not `unhealable` — they were never actually classified this
      // pass; the NEXT pass re-derives every one of them fresh from disk (no
      // tombstone, so a reappearing descriptor is still adopted).
      const deadlineHit = Number.isFinite(c.deadline) && Date.now() >= c.deadline;
      if (deadlineHit) {
        out.skipped += noDescriptorIds.length;
        if (noDescriptorIds.length) {
          out.detail.push({ action: 'deadline-skip', reason: 'no-descriptor bucket deferred to next pass', count: noDescriptorIds.length });
        }
      } else {
        for (const id of noDescriptorIds) {
          const resolved = resolvedById.get(id);
          if (resolved && resolved.resolveError) {
            out.errors++;
            out.detail.push({ id, action: 'error', reason: 'resolve raised: ' + resolved.resolveError });
            continue;
          }
          out.unhealable++;
          out.detail.push({ id, action: 'unhealable', reason: 'no-descriptor' });
        }
      }
      if (!dryRun && anyWrite) store.deriveSummary(s, { home, env: c.env });
    } finally { s.close(); }
    return out;
  } catch (e) {
    return {
      ok: false, error: String(e && e.message || e), scope: 'store',
      adopted: 0, forwarded: 0, unhealable: 0, archivedDrained: 0, archivedStale: 0,
      skipped: 0, errors: 0, detail: [],
    };
  }
}

// healOrphanPartitionsAllStores(home, ctx) — same cross-store sweep shape as
// foldMeshDuplicatesAllStores: healOrphanPartitions above only heals the ONE
// project store `ctx.cwd`/`ctx.repoKey` resolves to; this sweeps EVERY store this
// machine has ever opened (store.listStoreHashes(home)) and heals each directly by
// its stored hash. Same guarantees per store: idempotent, fail-open (a single
// store's failure is recorded and skipped, never aborts the sweep or throws out of
// this function), NO-DELETE.
// `scope: 'all-stores'` is carried in the return value itself (FIX C) so a
// printer/consumer never has to guess whether a given orphan-partition count came
// from this cross-store sweep or from the single-store healOrphanPartitions above —
// the two counts measure different things (this sweeps every store this machine has
// ever opened; the single-store call scopes to one repoKey) and previously had no
// way to distinguish themselves in their own output.
// Returns { ok, scope:'all-stores', stores, adopted, forwarded, unhealable,
//   archivedDrained, archivedStale, skipped, errors, results[] }.
function healOrphanPartitionsAllStores(home, ctx) {
  const c = ctx || {};
  let hashes = [];
  try { hashes = store.listStoreHashes(home) || []; } catch (_) { hashes = []; }
  let adopted = 0, forwarded = 0, unhealable = 0, archivedDrained = 0, archivedStale = 0, skipped = 0, errors = 0;
  const results = [];
  for (const repoKey of hashes) {
    let r = null;
    try {
      r = healOrphanPartitions(home, Object.assign({}, c, { repoKey }));
    } catch (e) {
      r = {
        ok: false, error: String(e && e.message || e), adopted: 0, forwarded: 0, unhealable: 0,
        archivedDrained: 0, archivedStale: 0, skipped: 0, errors: 0, detail: [],
      };
    }
    if (!r) continue;
    if (r.ok === false) { errors++; results.push({ repoKey, ok: false, error: r.error }); continue; }
    adopted += r.adopted || 0;
    forwarded += r.forwarded || 0;
    unhealable += r.unhealable || 0;
    archivedDrained += r.archivedDrained || 0;
    archivedStale += r.archivedStale || 0;
    skipped += r.skipped || 0;
    errors += r.errors || 0;
    if (r.adopted || r.forwarded || r.unhealable || r.archivedDrained || r.archivedStale || r.skipped || r.errors) {
      results.push({
        repoKey, ok: true, adopted: r.adopted || 0, forwarded: r.forwarded || 0,
        unhealable: r.unhealable || 0, archivedDrained: r.archivedDrained || 0,
        archivedStale: r.archivedStale || 0, skipped: r.skipped || 0, errors: r.errors || 0,
      });
    }
  }
  return {
    ok: true, scope: 'all-stores', stores: hashes.length, adopted, forwarded, unhealable,
    archivedDrained, archivedStale, skipped, errors, results,
  };
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
// foldArchivedFamilyDescriptors(home, ctx0) — FORWARD MIGRATION for descriptor
// sets ALREADY split by the archive bug before the fix shipped (this repo's
// persisted-shape rule: a shape change ships a migration in BOTH update and
// doctor). It is the DESCRIPTOR-file counterpart of foldArchivedRegistryRows
// below, which covers only the REGISTRY half.
//
// WHY A MIGRATION IS REQUIRED AND NOT OPTIONAL: cmdArchive's new whole-family
// retire only runs at archive TIME. Every workspace archived under the old code
// can still have a live cross-linked twin sitting in `workspaces/` right now, and
// that live descriptor is exactly what readDescriptors (companion/devswarm-
// supervisor.js) enumerates and what hooks/devswarm-parent-gate.js nags about —
// the un-clearable, every-turn block this whole change exists to end. Verified
// against a real install: `archived/fb-…-a55f20ef.json` (sessionId
// `8f3d585d-…`) sat beside a LIVE `workspaces/8f3d585d-….json`.
//
// SCOPE: only workspaces that are GENUINELY archived — `archived/<id>.json`
// present AND `workspaces/<id>.json` absent (the same isArchivedOnlyWorkspace
// test foldArchivedRegistryRows uses; a mid-archive/crashed state has BOTH and is
// applyRecoveryIntents' job, not this migration's).
//
// PROPERTIES (all load-bearing, matching foldArchivedRegistryRows' contract):
//   - IDEMPOTENT: a retired twin is gone from `workspaces/`, so a re-run finds no
//     candidate and reports nothing to do.
//   - NO-DELETE: a twin's bytes are hardlinked into `archived/` and the active
//     path is unlinked ONLY after a fresh lstat proves both are the same inode. A
//     tombstone already holding DIFFERENT bytes is never clobbered — that twin is
//     left live and surfaced. No message row is touched at all by this pass.
//   - SAFETY-GATED: the grouping is identityFamilyTwins' cross-link ONLY (one
//     row's sessionId IS the other's id), never bare worktree equality, so two
//     legitimately-live tabs on one worktree are never retired.
//   - FAIL-OPEN, HONESTLY: never throws into update/doctor, but a run that RAISED
//     reports ok:false with the error rather than a clean no-op.
// `ctx0.dryRun` classifies without writing and takes no lock (doctor's detect()).
function foldArchivedFamilyDescriptors(home, ctx0) {
  const dryRun = !!(ctx0 && ctx0.dryRun);
  const out = { ok: true, action: 'fold-archived-family-descriptors', dryRun, scanned: 0, pending: 0, retired: [], left: [], errors: 0 };
  try {
    const ad = checkedArchivedDir(home);
    if (!ad.ok || !ad.exists) return out;
    let names = [];
    try { names = fs.readdirSync(ad.path); } catch (_) { names = []; }
    for (const n of names) {
      if (!/\.json$/.test(n)) continue;
      const aid = n.slice(0, -5);
      if (!isSafeId(aid)) continue;
      // GENUINELY archived only: a live descriptor for the SAME id means a
      // mid-archive/crashed state, which this pass must not touch.
      if (fs.existsSync(descriptorPath(home, aid))) continue;
      let desc = null;
      try {
        const st = readDescriptorPathState(path.join(ad.path, n));
        if (st && !st.error && st.exists) desc = st.descriptor;
      } catch (_) { desc = null; }
      if (!desc || String(desc.id) !== String(aid)) continue;
      out.scanned++;
      let r;
      // requireWorktreeGone (P0-3): `desc` here is a TOMBSTONE — a historical
      // record of an identity that was archived, possibly long ago. Its
      // `sessionId` naming another descriptor's id is a one-way HISTORICAL link,
      // not proof that today's holder of that id is the same workspace. So this
      // path demands the twin's worktree be provably absent before retiring it;
      // anything else is left ACTIVE and reported in `left`. (cmdArchive's own
      // path does NOT set this: there the link is read from the LIVE descriptor
      // the operator is archiving right now, which IS contemporaneous authority.)
      try { r = retireIdentityFamilyDescriptors(home, aid, desc, { dryRun, requireWorktreeGone: true }); }
      catch (_) { out.errors++; continue; }
      for (const x of r.retired) out.retired.push(String(x));
      for (const x of r.left) out.left.push(x);
    }
    out.pending = out.retired.length;
    return out;
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e);
    return out;
  }
}

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
            for (const x of c.left) out.left.push({ id: String(x), bucket, reason: archiveLeftReason(home, x, rowOf.get(String(x)), !!(c.anchorLeft && c.anchorLeft.has(String(x)))) });
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
            out.left.push({ id: String(x), bucket, reason: archiveLeftReason(home, x, (g.leftRows && g.leftRows.get(String(x))) || rowOf.get(String(x)), !!(g.anchorLeft && g.anchorLeft.has(String(x)))) });
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
  // ARCHIVE RESURRECTION FIX (field defect a48db2e0ea08): archiving unlinks the
  // active descriptor (see cmdArchive), so a routine `ensure` — the path
  // cmdInboxPull's auto-ensure runs on EVERY turn from a still-running child —
  // saw `existing` as absent and fell through to the CREATE branch below,
  // silently rewriting a fresh descriptor AND upserting a live registry row:
  // the archived workspace reappeared active, undone by traffic nobody asked
  // to undo. Archiving is an operator/lifecycle decision; a background
  // auto-ensure must not silently reverse it. Gate ONLY the requireNew
  // (ensure/auto-ensure) path — the explicit `register` verb (requireNew
  // false, below) is the deliberate re-registration escape hatch and is left
  // exactly as it was: an operator (or a child) that explicitly re-registers
  // an archived id still revives it. Read-only, fail-closed check
  // (hasArchivedCounterpart never throws); never deletes anything.
  //
  // REUSED-ID FIX (P1-b field defect): ids are branch/worktree-derived and
  // branch names are commonly reused, so an exact-id archived match alone is
  // NOT proof this is the SAME workspace being resurrected — it can just as
  // easily be a genuinely NEW workspace that happens to reuse an old id.
  // archivedCounterpartInfo distinguishes the two using the one identity field
  // every descriptor carries (worktreePath), compared against THIS call's
  // resolved --worktree. Refusing forever on a false match was the bug; the
  // resurrection guard itself (below) is still correct and stays.
  let archivedNote = null;
  if (requireNew && !existing && hasArchivedCounterpart(home, id)) {
    const currentWorktree = one(flags, 'worktree');
    const info = archivedCounterpartInfo(home, id, currentWorktree);
    if (info.sameWorkspace === true) {
      return {
        ok: false, action: 'archived-skip', id, archived: true,
        reason: 'workspace ' + id + ' is archived; routine auto-ensure does not revive it'
          + ' (run `devswarm register ' + id + ' ...` to explicitly re-register)',
      };
    }
    if (info.sameWorkspace === false) {
      // Different worktree than the archived record -> a NEW workspace that
      // reuses this id. Allow the create below, but surface the archived
      // record loudly (never let this pass silently).
      archivedNote = {
        archivedRecordExists: true, sameWorkspace: false,
        archivedWorktreePath: info.archivedWorktreePath, currentWorktreePath: currentWorktree,
        note: 'an archived record for id ' + id + ' exists from a different worktree ('
          + info.archivedWorktreePath + '); treating this as a new workspace, not a resurrection',
      };
    } else {
      // Ambiguous (missing/unresolvable worktree info on either side): fail
      // OPEN per the guiding principle (a wrongful refusal is worse than an
      // occasional miss), but report it loudly rather than passing silently.
      archivedNote = {
        archivedRecordExists: true, sameWorkspace: null,
        archivedWorktreePath: info.archivedWorktreePath, currentWorktreePath: currentWorktree,
        note: 'an archived record for id ' + id + ' exists but same-workspace-vs-new could not be '
          + 'determined (missing worktree info); allowing (fail-open) — verify manually',
      };
    }
  }
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
    // ---- ID-DERIVED AUTHORITY GATE (defect e586afdaa968, P0) ----
    // The ownership check further down compares the descriptor's PERSISTED
    // ownerKey against this cwd — but the re-home immediately below REWRITES
    // that ownerKey to this cwd's key first, so the check was validating a
    // fact the previous statement had just manufactured. `ensure` on a
    // hash-stranded workspace whose worktree genuinely lives in ANOTHER
    // project therefore returned ok:true, moved that project's messages into
    // this one, and took ownership of the descriptor. Refuse FIRST, on the
    // id's own registered key (fresh worktree key, else the persisted
    // repoKey/ownerKey), before anything is written.
    // Fail-open unchanged: a descriptor that names no project at all
    // (registeredRepoKey === null — including the legacy hash bucket it is
    // stranded in) falls straight through to the re-home heal as before.
    {
      const registeredRepoKeyForEnsure = descriptorRegisteredRepoKey(existing, id);
      if (registeredRepoKeyForEnsure && registeredRepoKeyForEnsure !== currentRepoKey) {
        return projectContextMismatch(id, registeredRepoKeyForEnsure, currentRepoKey,
          'run this from within that project\'s worktree to ensure it');
      }
    }
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
    // BACKFILL (self-heal parity with the child turn hook's `defaultInboxPath`
    // backfill at devswarm-child-turn.js:447): a `primary-*` descriptor has no
    // per-turn hook to backfill a null/absent inboxPath, so it fails reconcile
    // ("descriptor has no inboxPath") forever unless THIS ensure path — which
    // runs on every `inbox pull` — repairs it. cmdInboxPull already computes a
    // correct default via pull.inboxDefaultPath/cursorDefaultPath and passes it
    // in ensureFlags every call; this branch used to silently discard it.
    // CONSERVATIVE: only fills a null/undefined/empty-string field, from the
    // caller's supplied flag first, falling back to the deterministic default —
    // NEVER overwrites an existing non-empty value.
    if (ensured.inboxPath === null || ensured.inboxPath === undefined || ensured.inboxPath === '') {
      ensured.inboxPath = one(flags, 'inbox') || pull.inboxDefaultPath(home, id);
    }
    if (ensured.cursorPath === null || ensured.cursorPath === undefined || ensured.cursorPath === '') {
      ensured.cursorPath = one(flags, 'cursor') || pull.cursorDefaultPath(home, id);
    }
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
  if (archivedNote) out.archivedNote = archivedNote;
  return out;
  });
}

// ===========================================================================
// `unclaimed:<id>` PROMOTION (carry-out (e), v0.90.0)
//
// ROOT CAUSE: cmdInboxPull's auto-ensure stamps `sessionId = 'unclaimed:' + id`
// when neither --session nor DEVSWARM_BUILDER_ID names a real session (its own
// A6 comment explains why minting the id itself was worse). That marker is
// correct AT STAMP TIME, but nothing ever took it back off: once a REAL session
// started reading/pulling/registering for that row, the row still read as
// `unclaimed:` — and isLiveSessionId REJECTS that prefix unconditionally, so
// every liveness-driven mesh primitive (resolveMeshTarget's routing, the reap /
// reconcile / retire safety gates, the supervisor's drainability check) kept
// treating a row a live session was actively draining as NOT live. A `send`
// could be routed away from it, and a sweep could class it as abandoned.
//
// defaultPpidOf(pid) -> parent pid, or null. Real implementation for
// deriveCallerSessionIdFromProcessTree below: `ps -o ppid= -p <pid>` via
// execFileSync (argv form — no shell interpolation), bounded by a short
// timeout so a hung/missing `ps` can never block the caller. Fail-soft:
// anything but a clean positive-integer parent pid yields null.
function defaultPpidOf(pid) {
  try {
    const cp = require('child_process');
    const out = cp.execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    const n = parseInt(String(out).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (_) { return null; }
}

const MAX_PPID_HOPS = 6;

// deriveCallerSessionIdFromProcessTree(ctx, opts) -> string | null.
//
// FALLBACK for realSessionIdFrom (defect 54a6539e2d69): --session and
// CLAUDE_CODE_SESSION_ID are the only two sources realSessionIdFrom reads, but
// MEASURED on this machine: CLAUDE_CODE_SESSION_ID is set in a DevSwarm-
// launched session's own Bash shell, and ABSENT in a plain (non-DevSwarm)
// Claude Code session's Bash shell. So a caller running an ordinary session
// had NO path to a real session id at all — `unclaimed:` promotion could
// never fire for it, regardless of how long the session ran.
//
// The Claude Code harness itself writes `<home>/.claude/sessions/<pid>.json`
// ({pid, sessionId, cwd, status, ...} — liveness.js's sessionsDirFor/
// sessionPidAlive already read this exact directory for a different purpose)
// for each running session. This walks the CALLER's OWN parent-pid chain
// (this process's pid, then its parent, grandparent, ... up to
// MAX_PPID_HOPS) looking for the first hop whose pid has a session file, and
// additionally REQUIRES that file's own `cwd` to resolve (canonical realpath,
// via the SAME canonicalWorktreeRealPath every fold/routing primitive in this
// file uses) inside the caller's own resolved worktree before trusting it —
// otherwise an unrelated ancestor process (a login shell, a sibling terminal
// tab, an unrelated wrapper) could be misattributed as this call's identity.
// A session file present with a NON-matching cwd is skipped (not fatal) and
// the walk continues up the chain, in case a closer/farther ancestor is the
// right one; the walk fails CLOSED (returns null) once the chain is
// exhausted or capped — a missed derivation is a retryable no-op on the next
// call, a wrong one would stamp a stranger's session id onto this row.
//
// `opts.ppidOf` (default: defaultPpidOf) and `opts.fs`/`opts.pid` are
// injectable so tests can supply a synthetic process chain and a fake
// sessions dir without spawning real processes or touching the real
// `~/.claude/sessions`. `opts.kill`/`opts.ps` are likewise injectable for the
// pid-reuse/staleness guard (see the `pidIsAlive` call below).
function deriveCallerSessionIdFromProcessTree(ctx, opts) {
  const o = opts || {};
  const home = ctx && ctx.home;
  if (!home) return null;
  const F = o.fs || fs;
  const ppidOf = typeof o.ppidOf === 'function' ? o.ppidOf : defaultPpidOf;
  const rawCwd = (ctx && ctx.cwd) || process.cwd();
  const callerWt = canonicalWorktreeRealPath(rawCwd) || rawCwd;
  if (!callerWt) return null;
  let sessDir;
  try { sessDir = sessionsDirFor(home); } catch (_) { return null; }
  let pid = Number.isInteger(o.pid) && o.pid > 0 ? o.pid : process.pid;
  const seen = new Set();
  for (let hop = 0; hop <= MAX_PPID_HOPS; hop++) {
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) break;
    seen.add(pid);
    let rec = null;
    try { rec = JSON.parse(F.readFileSync(path.join(sessDir, String(pid) + '.json'), 'utf8')); } catch (_) { rec = null; }
    if (rec && typeof rec === 'object' && rec.sessionId != null && rec.cwd) {
      const sid = String(rec.sessionId).trim();
      if (sid && !sid.startsWith(SYNTHETIC_SESSION_PREFIX)) {
        const recWt = canonicalWorktreeRealPath(String(rec.cwd)) || String(rec.cwd);
        if (recWt && recWt === callerWt) {
          // PID-REUSE / STALENESS GUARD (R22 P2): a session FILE naming this
          // pid is not proof the pid is still THAT session's process — the OS
          // can hand the same pid to an unrelated later process once the
          // original exits, and the stale file lingers if its owner never
          // cleaned it up. Reuse liveness.js's OWN guard (pidIsAlive's
          // `sinceMs` check, the same one sessionPidAlive already applies) via
          // this recorded file's own mtime as the reference: a live pid whose
          // OWN start time resolves to strictly AFTER this file was written
          // cannot be the process that wrote it. Fail-soft on an unstattable
          // file (sinceMs omitted, matching pidIsAlive's pre-existing
          // behavior) and on a `null` (no-opinion) verdict — only a PROVEN
          // dead/reused pid (`false`) is rejected; anything else falls back
          // to trusting the recorded session id, exactly as before this
          // guard existed.
          const rf = path.join(sessDir, String(pid) + '.json');
          let sinceMs = null;
          try { const st = F.statSync(rf); sinceMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : null; } catch (_) { sinceMs = null; }
          const recPid = Number.isInteger(rec.pid) && rec.pid > 0 ? rec.pid : pid;
          const pidOpts = Number.isFinite(sinceMs) ? { sinceMs, ps: o.ps } : undefined;
          const alive = pidIsAlive(recPid, o.kill, pidOpts);
          if (alive !== false) return sid;
          // dead/reused pid: this session file is stale — do not trust it,
          // but keep walking the chain in case an ancestor hop is legitimate.
        }
      }
    }
    let next = null;
    try { next = ppidOf(pid); } catch (_) { next = null; }
    if (!Number.isInteger(next) || next <= 1) break;
    pid = next;
  }
  return null;
}

// rowStillNeedsSessionDerivation(home, id, ctx) -> bool. GATE (R22 P2): the
// process-tree fallback (deriveCallerSessionIdFromProcessTree) spawns a real
// `ps` per hop of the caller's parent chain via defaultPpidOf. Before this
// gate, realSessionIdFrom ran that walk on EVERY inbox read/pull lacking
// --session/CLAUDE_CODE_SESSION_ID — including reads of a row ALREADY
// promoted to a real session id, where the walk's result can only ever be
// discarded (a fully-promoted descriptor's classic promotion path is already
// a no-op). This checks the row's CURRENT sessionId on both sides
// (descriptor AND registry, independently — the two can diverge, see
// promoteUnclaimedSession's divergence-repair header) and returns true (the
// walk should proceed) ONLY when at least one side still carries the exact
// `unclaimed:<id>` marker or has no sessionId at all; a row already real on
// BOTH sides returns false. Fail-OPEN on any read error (missing descriptor,
// unreadable registry): the pre-existing behavior always ran the walk, so an
// error here costs one unnecessary `ps` invocation rather than silently
// blocking a legitimate promotion.
function rowStillNeedsSessionDerivation(home, id, ctx) {
  if (!home) return true;
  try {
    const marker = SYNTHETIC_SESSION_PREFIX + String(id);
    let desc = null;
    try { desc = readDescriptorFile(home, id); } catch (_) { desc = null; }
    const descSid = desc && desc.sessionId != null ? String(desc.sessionId) : null;
    if (!descSid || descSid === marker) return true;
    const registrySid = currentRegistrySessionId(home, id, ctx);
    if (!registrySid || registrySid === marker) return true;
    return false;
  } catch (_) { return true; }
}

// realSessionIdFrom(flags, ctx, id) -> a REAL session id, or null.
// Three things are explicitly NOT real session ids and each returns null:
//   - the row's OWN id (the tautological ingest/descriptor fallback),
//   - anything still carrying SYNTHETIC_SESSION_PREFIX,
//   - an absent/blank value.
// `--session` wins over the env because an explicit flag is the caller stating
// its identity; CLAUDE_CODE_SESSION_ID is the ambient Claude Code session.
// FALLBACK (defect 54a6539e2d69): when NEITHER of those two names anything,
// derive the caller's real session id from the harness's own session files
// via deriveCallerSessionIdFromProcessTree — see that function's header for
// why (CLAUDE_CODE_SESSION_ID is absent in a plain, non-DevSwarm session) and
// its safety gate (cwd-verified parent-pid walk, fails closed). `ctx.env` is
// passed through so a test can supply `ctx.sessionDeriveOpts` to inject a
// synthetic process chain / sessions dir without touching real processes.
function realSessionIdFrom(flags, ctx, id) {
  const raw = (flags ? one(flags, 'session') : undefined)
    || (ctx && ctx.env && ctx.env.CLAUDE_CODE_SESSION_ID)
    || null;
  if (raw != null) {
    const s = String(raw).trim();
    if (s && s !== String(id) && !s.startsWith(SYNTHETIC_SESSION_PREFIX)) return s;
    return null;
  }
  if (!rowStillNeedsSessionDerivation(ctx && ctx.home, id, ctx)) return null;
  try {
    const derived = deriveCallerSessionIdFromProcessTree(ctx, ctx && ctx.sessionDeriveOpts);
    if (derived && derived !== String(id)) return derived;
  } catch (_) { /* fail-closed: no promotion from a throwing derivation */ }
  return null;
}

// currentRegistrySessionId(home, id, ctx) -> string | null. The CURRENT
// registry-side sessionId for `id`, read fresh (never the descriptor's own
// copy) — used by promoteUnclaimedSession's divergence repair below, which
// must compare descriptor vs registry independently rather than assuming
// they already agree. Fail-soft null on any throw/missing row.
function currentRegistrySessionId(home, id, ctx) {
  try {
    const ownerKey = storeOwnerKeyFor(id, ctx);
    const s = store.openStore({ home, workspaceId: id, hash: ownerKey, backend: ctx && ctx.backend, env: ctx && ctx.env });
    try {
      const row = s.listRegistry().find((r) => r && String(r.id) === String(id));
      return row && row.sessionId != null ? String(row.sessionId) : null;
    } finally { s.close(); }
  } catch (_) { return null; }
}

// promoteUnclaimedSession(home, id, sessionId, ctx) -> { promoted, from, to }.
//
// WRITE-THROUGH (descriptor AND registry, so the two can never diverge),
// IDEMPOTENT (a row whose sessionId is anything OTHER than the exact
// `unclaimed:<id>` marker — already promoted, or never unclaimed — is left
// untouched and reports promoted:false), and NO-DELETE (it only ever replaces
// one field's value; nothing is removed). Never throws: a failed descriptor or
// registry write degrades to "not promoted this call", which the NEXT read/pull
// retries, rather than failing the operation the caller actually asked for.
//
// DIVERGENCE REPAIR (defect 54a6539e2d69, added alongside the classic
// promotion path above): the classic path's `String(desc.sessionId) !==
// marker -> no-op` guard means that once the DESCRIPTOR moves off the
// marker, nothing ever calls this again with the descriptor still `unclaimed:`
// — so a REGISTRY write that failed on that earlier call (write-through's own
// registry step is wrapped in a swallowing try/catch, "registry retries next
// call" — but nothing ever retries it once the descriptor no longer matches
// the guard) left the registry stuck on the marker FOREVER, even though the
// descriptor already held the real identity (this is exactly the shape
// computeDiagnosis's descriptor/registry resolution, defect 2c4ae6576fab, was
// built to paper over on the READ side — this closes it on the WRITE side so
// the two stop diverging in the first place). The reverse (registry ahead of
// the descriptor) is repaired symmetrically. Both repair branches are
// ADDITIVE and IDEMPOTENT: they only ever copy one side's EXISTING real value
// onto the other, never invent a third value, and report `promoted:false`
// (this call performed a resync, not a NEW promotion) — reached only via
// maybePromoteUnclaimed's pre-existing callerOwnsRow gate, or the admin
// forward-migration sweep (promoteUnclaimedRegistrySessions) that already
// scopes itself to the current home's own descriptors.
function promoteUnclaimedSession(home, id, sessionId, ctx) {
  const out = { promoted: false, from: null, to: null };
  if (!sessionId || !isSafeId(id)) return out;
  const marker = SYNTHETIC_SESSION_PREFIX + String(id);
  let desc = null;
  try { desc = readDescriptorFile(home, id); } catch (_) { desc = null; }
  if (!desc) return out;
  const descSid = desc.sessionId != null ? String(desc.sessionId) : null;
  const registrySid = currentRegistrySessionId(home, id, ctx);

  if (descSid !== marker) {
    // Descriptor already promoted (by this or an earlier call — possibly to
    // a DIFFERENT real value than this call's `sessionId`; an already-real
    // descriptor is authoritative and is never overwritten here). Repair the
    // registry to match it ONLY if the registry is still stuck on the
    // marker for this SAME id.
    if (descSid && registrySid === marker) {
      const resynced = Object.assign({}, desc, { sessionId: descSid });
      try { upsertStoreRegistry(home, resynced, ctx, { allowPathChange: true }); } catch (_) { /* retried next call */ }
    }
    return out; // classic promotion is a no-op: descriptor is not currently unclaimed
  }

  if (registrySid && registrySid !== marker) {
    // Reverse divergence: the registry already holds a real value while the
    // descriptor still carries the marker. Sync the descriptor to the
    // registry's EXISTING real value (never this call's `sessionId` — the
    // registry's value is the one every routing/fold primitive already
    // treats as this row's identity).
    const resynced = Object.assign({}, desc, { sessionId: registrySid });
    try { writeDescriptorAtomic(home, id, resynced); } catch (_) { /* retried next call */ }
    return out; // no NEW promotion happened; this only resynced the descriptor
  }

  // Classic path: descriptor AND registry both still carry the marker ->
  // genuinely promote both, write-through.
  const next = Object.assign({}, desc, { sessionId: String(sessionId) });
  try { writeDescriptorAtomic(home, id, next); } catch (_) { return out; }
  // allowPathChange: the worktreePath is IDENTICAL (copied verbatim from the
  // descriptor we just read) — the flag only stops the F2 id-collision guard
  // from treating an unchanged path as a mismatch on a re-registered row.
  try {
    upsertStoreRegistry(home, next, ctx, { allowPathChange: true });
  } catch (e) {
    // R22 P2: descriptor already promoted; registry retries next call (the
    // divergence-repair branches above cover that retry) — but a SWALLOWED
    // failure here was previously invisible: nothing told the caller or an
    // operator that the registry write failed AT ALL, only that the row
    // stayed on `unclaimed:` for a call or two. Surface it: additive field on
    // the return value (never fails the promotion itself — descriptor
    // promotion already succeeded, so `out.promoted` stays true) plus one
    // stderr line for anyone watching logs.
    const msg = (e && e.message) ? String(e.message) : String(e);
    out.registryWriteError = msg;
    try { process.stderr.write('[devswarm] registry write failed for ' + String(id) + ': ' + msg + '\n'); } catch (_) { /* stderr write never affects the promotion */ }
  }
  out.promoted = true;
  out.from = marker;
  out.to = String(sessionId);
  try {
    alog.logEvent('devswarm-cli', 'unclaimed-session-promoted', 'info',
      'workspace ' + String(id) + ' promoted from ' + marker + ' to a real session id',
      { id: String(id), to: String(sessionId) });
  } catch (_) { /* logging never affects the promotion */ }
  return out;
}

// callerOwnsRow(home, id, ctx) -> boolean. Is `id` the CALLER's OWN row?
//
// ROUND 13 P0 (field): `maybePromoteUnclaimed` is called on the id being READ
// (cmdInboxMessagesInner + cmdInboxPull), and `realSessionIdFrom` sources the
// session from the CALLER's own `--session`/`CLAUDE_CODE_SESSION_ID`. So a
// Primary running `inbox read <twinId>` stamped ITS OWN live session uuid onto
// the TWIN's descriptor. The twin then read as LIVE (liveness.js isLiveSid),
// `siblingAckGate` refused to ack it, and its rows were re-delivered to the
// Primary on every single read, forever — the recurring sibling re-delivery
// this hotfix closes. Promotion is only ever legitimate for a row the caller
// can actually SPEAK FOR; a read target is not that by construction.
//
// THREE accepted proofs of ownership, in order of strength:
//   1. `id` IS the caller's canonical identity (callerIdentity — cwd-derived
//      ground truth, spoof-proof; a Primary reading its own `primary-<hash>`
//      row).
//   2. `id` is in the caller's IDENTITY FAMILY (crossLinkedIdentity: one row's
//      sessionId IS the other row's id — the builder-id/slug pair that is the
//      SAME agent registered twice). Deliberately NOT true for the twin shape
//      this defect is about: two `unclaimed:` rows on one worktree carry no
//      cross-link at all.
//   3. `id` is the SOLE registered row for the caller's resolved worktree — a
//      child pulling its own builder-id row from its own worktree, whose id is
//      NOT the worktree meshId `callerIdentity` returns. Restricted to the
//      UNIQUE case on purpose: the moment a worktree carries two rows (exactly
//      the twin shape), this proof is unavailable and nothing is promoted.
// Anything else -> NOT the caller's row -> no promotion. Fail-CLOSED: any
// throw/unreadable descriptor set answers false (a missed promotion is a
// retryable no-op; a wrong one strands a partition's mail).
function callerOwnsRow(home, id, ctx) {
  try {
    const target = String(id);
    const caller = callerIdentity(ctx && ctx.env, ctx && ctx.cwd);
    if (caller && String(caller) === target) return true;
    let descs = [];
    try { descs = readDescriptors(home) || []; } catch (_) { return false; }
    const targetRow = descs.find((d) => d && String(d.id) === target) || null;
    if (!targetRow) return false;
    const callerRow = caller ? (descs.find((d) => d && String(d.id) === String(caller)) || null) : null;
    let idFam = null;
    try { idFam = require('../companion/lib/devswarm-identity-family.js'); } catch (_) { idFam = null; }
    if (callerRow && idFam && idFam.crossLinkedIdentity(callerRow, targetRow)) return true;
    // (3) sole row for the caller's own worktree.
    const rawCwd = (ctx && ctx.cwd) || process.cwd();
    const wt = resolveCallerWorktree(rawCwd) || rawCwd;
    if (!wt || !targetRow.worktreePath) return false;
    const wtKey = canonicalMeshId(wt);
    if (!wtKey || wtKey !== canonicalMeshId(targetRow.worktreePath)) return false;
    let sameWorktreeRows = 0;
    for (const d of descs) {
      if (!d || !d.worktreePath) continue;
      if (canonicalMeshId(d.worktreePath) === wtKey) sameWorktreeRows++;
    }
    if (sameWorktreeRows !== 1) return false;
    // D11-A (P0 fix): clause 3 used to return true here unconditionally — "the
    // caller is the sole row on this worktree" — with NO check that the sole
    // row it just matched (`targetRow`, `target != caller`, already excluded
    // above by clauses 1/2) is actually the caller's OWN unclaimed placeholder.
    // A lone CLAIMED foreign row sharing the caller's worktree (a genuinely
    // different, already-registered session on the same checkout) satisfied
    // "sole row for this worktree" just as well as a real unclaimed
    // placeholder does, letting a caller stamp its own sessionId onto a
    // FOREIGN row it does not own — exactly the ownership violation this gate
    // exists to refuse (see OWNERSHIP-GATED at maybePromoteUnclaimed above).
    // Restrict clause 3 to the case it was actually meant for: the sole row is
    // unclaimed (empty or `unclaimed:`-prefixed sessionId), never a claimed one.
    const targetSid = targetRow.sessionId;
    const targetUnclaimed = targetSid == null || String(targetSid) === ''
      || String(targetSid).startsWith(SYNTHETIC_SESSION_PREFIX);
    return targetUnclaimed;
  } catch (_) { return false; }
}

// maybePromoteUnclaimed(home, id, flags, ctx) — the ONE call shape every
// read/pull/register path uses, so none of them re-derives "is this a real
// session id" for itself. Fail-soft in full.
//
// OWNERSHIP-GATED (Round 13 P0): see callerOwnsRow above — the caller's session
// id may only ever be stamped onto the caller's OWN row.
function maybePromoteUnclaimed(home, id, flags, ctx) {
  try {
    const sid = realSessionIdFrom(flags, ctx, id);
    if (!sid) return { promoted: false, from: null, to: null };
    if (!callerOwnsRow(home, id, ctx)) return { promoted: false, from: null, to: null, reason: 'not-own-row' };
    return promoteUnclaimedSession(home, id, sid, ctx);
  } catch (_) { return { promoted: false, from: null, to: null }; }
}

// ---------------------------------------------------------------------------
// FORWARD MIGRATION (persisted-shape rule): rows ALREADY stamped `unclaimed:`
// by an older build never get a promoting call if nothing reads them again.
// promoteUnclaimedRegistrySessions sweeps every descriptor and promotes only
// those with an INDEPENDENT, POSITIVE source of the real session id — today
// that is a heartbeat file whose own `sessionId` is a real one (cmdHeartbeat
// records `--session` verbatim). A row with no such source is LEFT EXACTLY AS
// IS (never deleted, never guessed at). Idempotent, fail-open, safe to run
// repeatedly; called from BOTH the update path and doctor-repair.
function promoteUnclaimedRegistrySessions(home, opts) {
  const o = opts || {};
  const ctx = { home, cwd: o.cwd || process.cwd(), env: o.env || process.env, backend: o.backend };
  const out = { ok: true, scanned: 0, promoted: [], left: [], errors: 0 };
  let descs = [];
  try { descs = readDescriptors(home) || []; } catch (_) { out.ok = false; out.errors++; return out; }
  for (const d of descs) {
    if (!d || !isSafeId(d.id)) continue;
    const marker = SYNTHETIC_SESSION_PREFIX + String(d.id);
    if (String(d.sessionId) !== marker) continue; // not unclaimed (or already promoted)
    out.scanned++;
    let beatSession = null;
    try {
      const beatPath = heartbeatPathFor(d.id, home); // liveness.js signature is (id, home)
      const beat = JSON.parse(fs.readFileSync(beatPath, 'utf8'));
      const raw = beat && beat.sessionId != null ? String(beat.sessionId).trim() : '';
      if (raw && raw !== String(d.id) && !raw.startsWith(SYNTHETIC_SESSION_PREFIX)) beatSession = raw;
    } catch (_) { beatSession = null; }
    if (!beatSession) {
      out.left.push({ id: String(d.id), reason: 'no-known-session' });
      continue;
    }
    let r;
    try { r = promoteUnclaimedSession(home, d.id, beatSession, ctx); }
    catch (_) { out.errors++; out.ok = false; continue; }
    if (r && r.promoted) {
      const row = { id: String(d.id), to: r.to };
      // R23 P2: surface a swallowed registry-write failure per-row, same
      // additive shape as inbox pull/read's `promotion.registryWriteError` —
      // descriptor promotion still succeeded (hence `promoted` here at all)
      // but the registry side may still be stuck on the marker.
      if (r.registryWriteError) row.registryWriteError = r.registryWriteError;
      out.promoted.push(row);
    } else out.left.push({ id: String(d.id), reason: 'write-failed' });
  }
  return out;
}

function cmdHeartbeat(id, flags, ctx) {
  const home = ctx.home;
  const dir = heartbeatsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  // R15 P2 (broadcastFamilyOwns leg a3, "placeholder row" test): captured
  // BEFORE this call's own base-heartbeat write below stamps `id`'s
  // heartbeats/<id>.json — that write always happens (the base heartbeat
  // "always succeeds" contract), so reading existence AFTER it would always
  // read true for the very id this call is about, poisoning the placeholder
  // check for exactly the only id it is ever asked about.
  const hadPriorHeartbeat = fs.existsSync(heartbeatPathFor(id, home));
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
  // A1-INSTRUMENT (spec item 1b): attribute the field-observed unidentified
  // dead-row refresher — any --session-less caller gets one capped NDJSON line.
  if (one(flags, 'session') === undefined) appendHeartbeatCallerLog(home, id, now);
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

  // P2-11 (+ later union fix): compute `pending`/`notDraining`/`oldestUnreadAgeMs`
  // the SAME way computeLiveness does on its fresh-heartbeat short-circuit
  // (liveness.js's unionPendingFor — NDJSON ∪ store, not NDJSON-only) so the two
  // verdict-write paths AGREE — a disagreement here (this path stamping
  // `pending:false` over a store-only backlog the supervisor sweep reports as
  // `pending:true`) flaps the parent-gate signal exactly like the original P2-11
  // bug this comment used to describe. unionPendingFor is already fail-open
  // (falls back to NDJSON-only, never throws) so no extra try/catch semantics
  // are needed beyond what it already provides.
  let pending = false;
  let notDraining = false;
  let oldestUnreadAgeMs = null;
  try {
    const descForPending = readDescriptorFile(home, id);
    if (descForPending) {
      const union = unionPendingFor(descForPending, home, { now });
      pending = !!union.pending;
      notDraining = !!union.notDraining;
      oldestUnreadAgeMs = Number.isFinite(union.oldestUnreadAgeMs) ? union.oldestUnreadAgeMs : null;
    }
  } catch (_) {
    pending = false; notDraining = false; oldestUnreadAgeMs = null; // fail-open
  }

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
      nudgeAttempts: 0, nudgedAt: null, pending, notDraining, oldestUnreadAgeMs,
      heartbeatTs: now,
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
          const ownEntry = resolveMeshTarget(s, caller, home);
          // DEFECT ecd7ad60e4cc (P1) — IDENTITY-FAMILY MEMBERSHIP, NOT RAW-ID
          // EQUALITY. `resolveMeshTarget` returns exactly ONE row: whichever of
          // the caller's same-worktree rows pickFreshestLive ranks highest. A
          // child registered TWICE for one worktree (the builder-id UUID row +
          // the slug row — the documented pair in companion/lib/
          // devswarm-identity-family.js's header) therefore fails this check
          // whenever the winner is not the id being heartbeated: the field
          // report is `callerIdentity <builder-id> does not own <slug>`, with
          // DIRECT sends from the same child working fine (cmdSend resolves the
          // whole mesh group, not one row). The consequence is silent: the
          // refusal is BENIGN, so exit code 0 and ok:true, and the child's
          // working_on summary never reaches the mesh — the parent then reads
          // the child as going stale while it is heartbeating every turn.
          // realSessionIdFrom (Round 13 P0's established "caller's real session
          // id" helper — already trusted by callerOwnsRow/maybePromoteUnclaimed
          // for exactly this question) rather than the raw `beat.sessionId`
          // flag value: it filters out a self-referential id and a synthetic
          // `unclaimed:`-prefixed value, neither of which is a real session.
          const callerSessionId = realSessionIdFrom(flags, ctx, id);
          const owns = caller === id
            || (ownEntry && ownEntry.id === id)
            || broadcastFamilyOwns(s, caller, id, home, ownEntry, cwd, callerSessionId, hadPriorHeartbeat);
          if (!owns) {
            // A7: name WHICH leg failed instead of one generic message for
            // an unresolvable identity, an unregistered caller, AND a genuine
            // mismatch alike.
            const cause = ownershipRefusalCause(callerInfo.kind, ownEntry);
            meshBroadcast = {
              ok: false,
              reason: cause,
              // CARRY-OUT (g): the refusal stays BENIGN — `ok:true` at the top
              // level, exit code 0 — because it is a working security control
              // doing its job, and the BASE heartbeat genuinely succeeded (see
              // BENIGN_MESH_BROADCAST_REASONS). But "benign" was being read by
              // callers as "applied": nothing in the response said the SUMMARY
              // itself was thrown away, so a caller that set --summary and got
              // ok:true had no way to learn its working_on text never reached
              // the mesh. `dropped`/`dropReason` say so explicitly, WITHOUT
              // changing the ok:true contract this reason deliberately keeps.
              // Scoped to this refusal only — no other benign reason's shape
              // changes (the no-project dormancy case is untouched).
              dropped: true,
              dropReason: cause,
              error: 'heartbeat --summary refused (' + cause + '): caller ' + JSON.stringify(caller)
                + ' does not own workspace ' + JSON.stringify(id)
                + ' — the summary was DROPPED (not broadcast); the base heartbeat still succeeded',
              callerIdentity: caller,
              // D11-A (d35d2d4b241e): ADDITIVE — surface callerIdentityDetailed's
              // `kind` (resolved/declared/unresolvable) alongside the existing
              // `callerIdentity` string, never replacing it.
              identity: { id: caller, kind: callerInfo.kind },
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
  // D11-A (d35d2d4b241e): ADDITIVE — surface callerIdentityDetailed's `kind`
  // (resolved/declared/unresolvable) on the SUCCESS result too, not only the
  // ownership-refusal path above (which already carries it). Computed fresh
  // here (callerIdentityDetailed is a pure cwd/env resolution, no fs writes)
  // rather than threading the summary-branch's own `callerInfo` out of its
  // narrower scope — this never fires when --summary is absent, so a
  // second, cheap call keeps this additive without restructuring that path.
  let identity = null;
  try {
    const d = callerIdentityDetailed(ctx.env, ctx.cwd || process.cwd());
    identity = { id: d.identity, kind: d.kind };
  } catch (_) { identity = null; }
  return { ok: !hardMeshFailure, action: 'heartbeat', id, heartbeat: beat, meshBroadcast, identity };
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
  // carry-out (e): `requireNew` leaves an EXISTING descriptor untouched, so a
  // row stamped `unclaimed:` by an earlier session-less pull would stay that way
  // forever even once a real session started pulling it. Promote AFTER the
  // ensure (so a freshly-created descriptor is already correct and this no-ops).
  const promotedPull = maybePromoteUnclaimed(home, id, flags, ctx);
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
  // ADDITIVE, present only when it actually happened (so an unchanged pull's
  // output stays byte-identical for existing parsers).
  if (promotedPull && promotedPull.promoted) out.sessionPromoted = promotedPull.to;
  // R23 P2: promoteUnclaimedSession's registryWriteError was previously
  // dropped here — a failed registry write (descriptor promoted, registry
  // still stuck on the `unclaimed:` marker) was invisible to every caller of
  // `inbox pull`. Additive `promotion` object, present only when a promotion
  // happened or a registry write actually failed this call.
  if (promotedPull && (promotedPull.promoted || promotedPull.registryWriteError)) {
    out.promotion = { promoted: !!promotedPull.promoted };
    if (promotedPull.registryWriteError) out.promotion.registryWriteError = promotedPull.registryWriteError;
  }
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
function resolveWorkspaceStoreForRead(id, ctx, home, roOpts) {
  // skipExistenceGuard (FIX 5 wiring): cmdInboxMessages' OWN ownership check
  // (doAck && !ackAsOwner, below) is a MORE specific, already-fail-closed guard
  // for exactly the case where an ack is requested without the explicit
  // ack-as-owner override — running the existence guard first would preempt it
  // and lose that check's richer response shape (callerIdentity, refusal
  // reason). The traced bug repro used `--ack-as-owner`, which BYPASSES that
  // ownership check entirely — the existence guard exists to catch that case
  // (and every non-ack read), so it stays active everywhere else.
  const skipExistenceGuard = !!(roOpts && roOpts.skipExistenceGuard);
  // ---- ID-DERIVED AUTHORITY GATE (defect e586afdaa968) ----
  // Everything below this point (the re-home, the store open, and every cursor
  // write the callers perform against the returned handle) acts on a partition
  // chosen by the CALLER'S cwd. That is only correct when the cwd agrees with
  // the workspace's OWN registered project — so the disagreement is resolved
  // FIRST, before any of it runs. Two things changed here:
  //   1. the authority is descriptorRegisteredRepoKey (fresh key, else the
  //      descriptor's PERSISTED repoKey/ownerKey) — the pre-fix guard used
  //      descriptorFreshRepoKey ONLY, so a workspace whose worktree no longer
  //      resolved silently lost its guard and the caller's cwd took over;
  //   2. this refusal now precedes maybeRehomeToCwdProject — which re-homes to
  //      `repoKeyForCwd(ctx)` and, when it ran first, physically copied a
  //      FOREIGN workspace's messages + registry row into the caller's
  //      partition and rewrote its descriptor ownerKey, on a plain
  //      non-mutating read.
  // This early return IS the "never advance a cursor in a partition that was
  // not resolved from the workspace's own registered repoKey" guarantee: past
  // this point the partition is either the id's own registered project, or the
  // id has no registered project at all (the sanctioned legacy/no-project mode,
  // where the per-id hash bucket IS id-derived).
  const callerRepoKeyForRead = repoKeyForCwd(ctx);
  const descForRead = readDescriptorFile(home, id);
  const registeredRepoKeyForRead = descForRead ? descriptorRegisteredRepoKey(descForRead, id) : null;
  if (registeredRepoKeyForRead && registeredRepoKeyForRead !== callerRepoKeyForRead) {
    return {
      ok: false, id,
      reason: 'project-context-mismatch',
      registeredRepoKey: registeredRepoKeyForRead,
      callerRepoKey: callerRepoKeyForRead || null,
      error: 'workspace ' + JSON.stringify(id) + ' is registered under project ' + JSON.stringify(registeredRepoKeyForRead)
        + (callerRepoKeyForRead
          ? (', but the current context resolves to a DIFFERENT project ' + JSON.stringify(callerRepoKeyForRead))
          : ', but the current context could not resolve a project (non-git cwd?)')
        + ' — run this from within that project\'s worktree to read its inbox',
    };
  }
  // P1-1/P1-2 RE-HOME (read path): if this workspace is still stranded in the
  // legacy hash bucket (persisted ownerKey=hash) while repoKey now resolves, its
  // messages are in a bucket the repoKey-keyed read below would never open — a
  // silent black hole. Migrate them (registry row + backlog + cursor) into
  // store/<repoKey>/ FIRST so the read that follows actually sees them. Best-
  // effort + under the per-id lock; a no-op when not stranded.
  try { maybeRehomeToCwdProject(home, id, ctx); } catch (_) { /* fail-open: read proceeds regardless */ }
  // A1(c) (SUPERSEDED IN PLACE by the ID-DERIVED AUTHORITY GATE above, defect
  // e586afdaa968): the same cross-project refusal this block used to perform
  // now runs BEFORE the re-home, and resolves `id`'s project from
  // descriptorRegisteredRepoKey (fresh key, else the descriptor's persisted
  // one) instead of descriptorFreshRepoKey alone. `callerRepoKeyForRead` /
  // `descForRead` are resolved up there and reused here — an id with NO
  // descriptor, or whose descriptor names no project at all, still falls back
  // to the caller's own key exactly as before (the sanctioned legacy/no-project
  // mode, exercised extensively by this suite's default non-git `ctx()` cwd).
  // v0.57 mesh (D24): this opens the SAME shared per-project store the per-project
  // ingest daemon natively drains INTO (D8/D21) — without this re-key, a reader
  // would open the legacy per-id bucket the daemon no longer writes to and
  // silently see nothing.
  const s = store.openStore({ home, workspaceId: id, hash: callerRepoKeyForRead || undefined, backend: ctx.backend, env: ctx.env });
  // FIX 5 (TRACED, highest severity — P0): the only guard above is a cross-project
  // repoKey MISMATCH, gated on a descriptor existing at all. An `id` with NO
  // descriptor, NO registry row, AND NO messages skipped every guard and reached
  // here, opening a store that trivially reports messageCount 0 / listMessages []
  // — `ok:true` for a workspace that was never registered at all. Contrast
  // `send --to` (resolveSendTarget, ~line 4519), which fails closed as
  // `unregistered-recipient` for exactly this case — the write path validates
  // identity, the read path did not. Mirror it, but stay compatible with the
  // codebase's OTHER supported pattern (`seedStore`-style direct message-store
  // seeding with NEITHER a descriptor NOR a registry row, exercised extensively
  // by this suite — see e.g. devswarm-cli.test.js's "no descriptor needed" test):
  // fail closed ONLY when `id` has genuinely NOTHING backing it — no descriptor,
  // no registry row, AND zero messages in the store just opened. A registry-only
  // row (e.g. the `spawn` placeholder at ~line 5705) or a message-seeded-only
  // partition still passes; only a truly nonexistent id (0 signals of any kind)
  // is refused.
  if (!descForRead && !skipExistenceGuard) {
    let hasRegistryRow = false;
    let hasMessages = false;
    try { hasRegistryRow = (s.listRegistry() || []).some((r) => r && String(r.id) === String(id)); } catch (_) { hasRegistryRow = false; }
    try { hasMessages = s.messageCount(id) > 0; } catch (_) { hasMessages = false; }
    if (!hasRegistryRow && !hasMessages) {
      try { s.close(); } catch (_) {}
      return {
        ok: false, id,
        reason: 'unregistered-workspace',
        error: 'workspace ' + JSON.stringify(id) + ' is not registered and has no messages '
          + '(no descriptor, no registry row, no store history) — register it first (or check the id for a typo)',
      };
    }
  }
  return { ok: true, store: s };
}

// ndjsonHashesFromLines / ndjsonAllHashes — MOVED to companion/lib/devswarm-unread.js
// (the canonical copy, shared with hooks + liveness.js; devswarmUnread.unionUnread
// above now does this work internally, so nothing in this file calls these two
// directly anymore).

// DEFAULT_INBOX_READ_LIMIT (defect 8d0a66cfc563): read-primary/peek-primary/
// --ack merge EVERY mesh-group partition plus the NDJSON channel with no cap
// at all — a real field case returned 489 messages in a single read. 2000 is
// roughly 4x that largest observed real case, generous enough that no normal
// mesh-heavy backlog is ever disrupted, while still bounding the genuinely
// pathological case (a stuck sender loop, a runaway broadcast) that would
// otherwise grow this read unboundedly forever. --limit overrides it
// per-call; a non-finite or non-positive override is ignored (falls back to
// this default) rather than silently disabling the cap.
const DEFAULT_INBOX_READ_LIMIT = 2000;

// NEVER_READ_SIBLING_CAP (confirmed field defect, root-cause trace): a sibling
// partition this caller has NEVER read/acked before (pCursor === 0 — genuinely
// untouched, not just "caught up to 0") has its ENTIRE history pulled by the
// mesh-sibling union read below (`sinceCursor: 0`), then merged and ts-sorted
// with every other source. A field case with three never-read `primary-*`
// siblings returned 753 messages (1.7MB) in ONE `read-primary` call — under
// DEFAULT_INBOX_READ_LIMIT (2000), so the existing merged-total cap never
// engaged; the dump was real, not a truncation artifact.
//
// DECISION: cap a never-read sibling's OWN contribution to a bounded PREFIX
// (this constant) BEFORE it ever reaches the merge/ts-sort/general-cap
// pipeline below — reusing that SAME pipeline's structural-prefix invariant
// (a "prefix" cap can never advance a cursor past a withheld row, because the
// ack-target math derives its target from `part.deliveredCount`/the rows
// actually present in `part.messages`, never from `part.total`) rather than
// inventing a second cap mechanism. Rejected alternative: requiring an
// explicit flag to pull a never-read sibling's history at all — that would
// silently degrade every existing caller's `read-primary`/`peek-primary`
// behavior (today's default IS "show me everything unread"); a bounded-tail
// default that stays loss-free (never acks past what it withheld) preserves
// today's contract for the common case (a sibling with a normal-sized
// backlog) while bounding the pathological one (a sibling that has
// accumulated years of history because nothing ever read it).
// A PREFIX (earliest-first, natural listMessages order), never a "most
// recent N" tail: only a structural prefix can be safely combined with the
// existing "ack target = rows actually delivered" invariant everywhere else
// in this file — capping to the newest N would require skipping over
// untouched middle rows, which this file's ack math cannot express without
// risking exactly the message-loss shape Fix Wave 2/3 already fixed.
// Deliberately smaller than DEFAULT_INBOX_READ_LIMIT: this guards the
// FIRST-EVER read of one sibling, not the caller's overall per-call budget
// (multiple never-read siblings can still each contribute up to this many
// rows; the general cap above still bounds the combined total).
const NEVER_READ_SIBLING_CAP = 200;

// ---------------------------------------------------------------------------
// BOUNDED RECENT-MAIL WINDOW: `--since` / `--tail` (defect 3f6027ee462a).
//
// THE GAP: `inbox messages` returned an EARLIEST-FIRST prefix bounded only by
// `--limit`, so the only ways to see RECENT mail were (a) the destructive
// `read-primary` (which acks and consumes) or (b) dumping the whole store. And
// a `--tail 3` typed against it today is SILENTLY DROPPED — this file never
// rejects unknown flags, so the caller gets the earliest rows back believing
// they got the newest. Silent-drop is the actual defect; honoring the flag on
// the safe verb and REJECTING it on the unsafe ones both fix it.
//
// WHY NON-ACKING VERBS ONLY (this is a hard constraint, not a scoping choice):
// every ack path in this file derives its cursor target from "the rows actually
// delivered, as a contiguous structural PREFIX" (see NEVER_READ_SIBLING_CAP's
// header and the P2-D cap). A most-recent-N tail is by construction NOT a
// prefix — it skips untouched middle rows — and this file's ack arithmetic
// cannot express "delivered rows 98..100, rows 1..97 still pending" without
// re-introducing exactly the message-loss shape Fix Wave 2/3 closed. So the
// window is a PURE READ PROJECTION applied to the already-computed result of
// the plain, non-acking `inbox messages` verb, and any ack-bearing verb
// (`inbox read`, `inbox ack`, `read-primary`, `inbox messages --ack`) REJECTS
// these flags loudly instead of ignoring them.
// `peek-primary` is non-acking but is deliberately also refused: it exists to
// answer exactly one question ("what would read-primary show me"), and a
// windowed answer to that question would be a lie about what read-primary
// would deliver.
const INBOX_WINDOW_FLAGS = ['tail', 'since'];
// inboxWindowRejection(flags, verb) -> {ok:false,...} | null. `null` == no
// window flag was passed (nothing to reject).
function inboxWindowRejection(flags, verb) {
  const used = INBOX_WINDOW_FLAGS.filter((f) => one(flags, f) !== undefined);
  if (!used.length) return null;
  return {
    ok: false,
    error: '--' + used.join('/--') + ' is not supported on `' + verb + '` — it acks (or reports on) a '
      + 'CONTIGUOUS unread prefix, and a windowed/most-recent-N view cannot be expressed as a prefix '
      + 'without risking skipped mail. Use the non-acking read instead: `inbox messages <id> '
      + used.map((f) => '--' + f + ' <v>').join(' ') + '`.',
    reason: 'window-flags-unsupported-on-acking-verb',
    flags: used,
    verb,
  };
}
// parseInboxSince(raw) -> {kind:'index', value:n} | {kind:'ts', value:ms} | null.
// A bare NON-NEGATIVE INTEGER is an INDEX (the per-partition positional ordinal
// listMessages emits as `index`, and the same space `cursor` counts in) — that
// is what the field request asked for ("--since <index>"). Anything else is
// parsed as a DATE via Date.parse (ISO 8601 and every other format V8 accepts).
// Deliberately NOT a magnitude heuristic ("big numbers are epoch ms"): an
// operator wanting a timestamp writes an ISO string, which is unambiguous.
function parseInboxSince(raw) {
  const str = String(raw).trim();
  if (str === '') return null;
  if (/^\d+$/.test(str)) {
    const n = Number(str);
    if (!Number.isFinite(n)) return null;
    return { kind: 'index', value: Math.floor(n) };
  }
  const ts = Date.parse(str);
  if (!Number.isFinite(ts)) return null;
  return { kind: 'ts', value: ts };
}

// inboxReadDoesAck(flags, opts) -> boolean. The ONE derivation of "this call
// will advance a cursor", shared by cmdInboxMessages' drain-marker wrapper and
// the read body itself so the two can never disagree about whether a drain is
// in flight (a wrapper that marked a drain the body then didn't perform would
// silence the parent gate for a read that acked nothing).
function inboxReadDoesAck(flags, opts) {
  return !!((opts && opts.ack) || (flags && flags.ack));
}

// cmdInboxMessages — DRAIN-MARKER WRAPPER (defect 13dedc334eb6, P2).
//
// The write half of companion/lib/devswarm-drain-marker.js, whose header names
// this exact call site: the ack-bearing read path (`inbox read-primary`,
// `inbox read`, any `--ack`) declares "I am draining my mailbox right now" at
// ENTRY and clears it in a `finally`. devswarm-parent-gate.js's Stop hook
// (~:1389-1402) reads that marker and, when it is fresh AND belongs to this
// session, downgrades its forced acknowledgement to a non-blocking notice —
// instead of firing repeated forced acks (and an escalation) at a mailbox a
// delegated subagent is already draining, whose pressure pushes toward a
// SECOND reader against the same cursor, the action most likely to lose mail.
//
// SESSION ID: the gate compares `marker.sessionId` against the Stop payload's
// `payload.session_id` — the real Claude Code session uuid. `CLAUDE_CODE_
// SESSION_ID` is the env var Claude Code sets on every process it spawns and
// is therefore the SAME value the hook sees (this file already treats it as
// the authoritative session handle in cmdRegisterPrimary and cmdGateIntent).
// It is preferred for that reason; the descriptor's recorded sessionId is only
// a fallback for a CLI invoked outside a Claude session. `pid` is recorded by
// the marker module itself and gives the gate a second identity leg, though it
// rarely matches in practice (the hook and this CLI are different processes).
//
// NON-ACKING reads are deliberately NOT marked: a pure `inbox messages` read
// consumes nothing, so it is not a drain and must never silence the gate.
//
// NEVER THROWS: the lazy require, the marker write and the clear are each
// individually guarded. A missing/broken marker module, an unwritable home, or
// an unsafe id degrade to "no marker" — the gate simply blocks as it did
// before, which is the safe direction. The marker must never be able to break
// a read that would otherwise have succeeded.
function cmdInboxMessages(id, flags, ctx, opts) {
  if (!inboxReadDoesAck(flags, opts)) return cmdInboxMessagesInner(id, flags, ctx, opts);
  let marker = null;
  try {
    marker = require('../companion/lib/devswarm-drain-marker.js');
  } catch (_) { marker = null; }
  if (!marker || typeof marker.markDrainStart !== 'function') {
    return cmdInboxMessagesInner(id, flags, ctx, opts);
  }
  let sessionId = (ctx && ctx.env && ctx.env.CLAUDE_CODE_SESSION_ID) || null;
  if (!sessionId) {
    // Descriptor fallback — a plain file read (no store open), so a drain is
    // never slowed by resolving its own identity.
    try {
      const d = readDescriptorFile(ctx.home, id);
      if (d && d.sessionId != null && String(d.sessionId) !== '') sessionId = String(d.sessionId);
    } catch (_) { /* no identity available -> marker still written, pid-only */ }
  }
  // R12 Critic P1 — NEVER INHERIT A NON-SESSION IDENTITY. The descriptor
  // fallback above reads whatever `sessionId` the registry/descriptor holds,
  // and two shapes there are NOT session ids at all:
  //   1. the TAUTOLOGICAL ingest fallback `sessionId === id` (a descriptor
  //      auto-seeded from the row's own id), and
  //   2. the SYNTHETIC `unclaimed:<id>` marker cmdInboxPull stamps when no real
  //      session claimed the row (see cmdInboxPull's A6 comment).
  // Writing either into the drain marker is worse than writing nothing: the
  // gate's consumer compares `marker.sessionId` against the Stop payload's real
  // session uuid, so a non-session value can never match — but it DOES make the
  // marker claim an identity it does not have, which any future consumer that
  // treats a non-null sessionId as "a known session is draining" would read as
  // authoritative. `null` is the honest value ("a drain is in flight; whose is
  // unknown"), and the marker still carries `pid` as its second identity leg.
  if (sessionId != null && (String(sessionId) === String(id)
    || String(sessionId).startsWith(SYNTHETIC_SESSION_PREFIX))) {
    sessionId = null;
  }
  try {
    // `count` is 0 = NOT YET KNOWN at entry, which is the honest value here:
    // the number of rows this drain will deliver is only established by the
    // read itself, and computing it up front would mean a second store open +
    // a full union recompute — precisely the expense this marker exists to let
    // the gate stop provoking. The marker's sole consumer (the parent gate)
    // reads startedAt/sessionId/pid and never `count`.
    marker.markDrainStart(ctx.home, id, { sessionId, count: 0, now: ctx && ctx.now });
  } catch (_) { /* fail-soft: an unmarked drain is just an un-silenced gate */ }
  try {
    return cmdInboxMessagesInner(id, flags, ctx, opts);
  } finally {
    // `finally`, not a post-return call: a THROW mid-drain must still clear the
    // marker rather than leave it silencing the gate until its TTL expires.
    try { marker.clearDrainMarker(ctx.home, id); } catch (_) { /* fail-soft */ }
  }
}

function cmdInboxMessagesInner(id, flags, ctx, opts) {
  const home = ctx.home;
  // carry-out (e): a REAL session reading this row's mailbox is proof the row
  // is claimed — take the `unclaimed:` marker off before anything below decides
  // liveness from it. Idempotent, fail-soft, and a pure no-op for every row that
  // is not carrying the marker.
  const promotedInner = maybePromoteUnclaimed(home, id, flags, ctx);
  const doAck = inboxReadDoesAck(flags, opts);
  // forceUnread (spec item 5b / D): lets `peek-primary` request the SAME
  // unread-only view as `read-primary` (opts.ack:true implies it) WITHOUT
  // itself acking — a genuinely non-mutating peek at what read-primary would
  // show, never advancing the cursor.
  const forceUnread = !!(opts && opts.unread);
  // FIX 2 (TRACED): this was named `unread` and returned verbatim under that same
  // key below — a MODE flag (whether to scope the read to the unread tail), while
  // the summary projection (devswarm-store.js deriveSummary) emits `unread` as a
  // COUNT. Renamed to `unreadOnly`; the actual count is reported separately as
  // `unreadCount` below.
  const unreadOnly = !!flags.unread || doAck || forceUnread; // read-primary is inherently unread-then-ack
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
  // --since / --tail (defect 3f6027ee462a) — see INBOX_WINDOW_FLAGS' header for
  // WHY this is refused on every ack-bearing/unread-scoped call rather than
  // silently ignored there. Refusal happens BEFORE any store open or read, so a
  // rejected call is a pure no-op.
  {
    const rej = inboxWindowRejection(flags, doAck
      ? ((opts && opts.action) || 'inbox read-primary')
      : 'inbox peek-primary');
    if (rej && (doAck || forceUnread)) return rej;
  }
  let windowTail = null;
  let windowSince = null;
  const windowActive = !doAck && !forceUnread
    && INBOX_WINDOW_FLAGS.some((f) => one(flags, f) !== undefined);
  if (windowActive) {
    const tailRaw = one(flags, 'tail');
    if (tailRaw !== undefined) {
      const n = Number(tailRaw);
      // A bad --tail is an ERROR, never a silent fallback: the whole point of
      // this defect is that an ignored window flag makes the caller believe a
      // bounded recent view was applied when it was not.
      if (!Number.isFinite(n) || n < 1) {
        return { ok: false, error: '--tail must be a positive integer (got ' + JSON.stringify(String(tailRaw)) + ')', reason: 'bad-tail' };
      }
      windowTail = Math.max(1, Math.floor(n));
    }
    const sinceRaw = one(flags, 'since');
    if (sinceRaw !== undefined) {
      windowSince = parseInboxSince(sinceRaw);
      if (!windowSince) {
        return {
          ok: false,
          reason: 'bad-since',
          error: '--since must be a non-negative integer (a per-partition message index, the same space `cursor` counts in) '
            + 'or a parseable date such as an ISO 8601 timestamp (got ' + JSON.stringify(String(sinceRaw)) + ')',
        };
      }
    }
  }
  // --limit N (defect 8d0a66cfc563): override DEFAULT_INBOX_READ_LIMIT for
  // this call. Ignored (falls back to the default) unless a finite, positive
  // number — silently disabling the cap via a bad value is not an option.
  let inboxReadLimit = DEFAULT_INBOX_READ_LIMIT;
  const limitRaw = one(flags, 'limit');
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (Number.isFinite(n) && n > 0) inboxReadLimit = Math.max(1, Math.floor(n)); // F4: a fractional --limit (e.g. 0.5) must not floor to 0 and disable the cap
  }
  const cursorPath = primaryCursorPath(home, id);
  const cursor = inboxCursor.readCursor(cursorPath);
  // defect dca4d2e16926: `messages`/`read-primary`/`peek-primary` used to be
  // STORE-ONLY (s.messageCount/s.listMessages below), while `inbox count/read/
  // ack` already union the store partition with the NDJSON descriptor inbox
  // (devswarmUnread.unionUnread — see that sub's own header comment a few
  // hundred lines down). That let `inbox count` report real unread mail a
  // Primary's OWN read path (`read-primary`) could never see. Wire this verb
  // onto the SAME union, gated to the unread-scoped calls (read-primary,
  // peek-primary, and any `--ack`) — a plain `inbox messages <id>` (full
  // history, no ack) is unaffected, matching its pre-fix contract exactly.
  const wantsUnion = doAck || forceUnread;
  const desc = wantsUnion ? readDescriptorFile(home, id) : null;
  const openedForRead = resolveWorkspaceStoreForRead(id, ctx, home, { skipExistenceGuard: doAck && !ackAsOwner });
  if (!openedForRead.ok) return openedForRead;
  const s = openedForRead.store;
  let total, messages, acked, union = null;
  // 8d0a66cfc563 cap bookkeeping — declared outside the try{} block below (it
  // is read again while building `out`, after the try/finally has closed `s`).
  let withheldBySource = null;
  let truncatedCount = 0;
  let meshAddedUnreadCount = 0; // count of sibling-partition rows folded into `messages` after dedup (0 unless meshUnionActive)
  let meshAddedTotal = 0; // Σ sibling partitions' own full `messageCount` (0 unless meshUnionActive) — undeduped, mirrors how `total` was never cross-source-deduped pre-fix either (only `messages`/`unreadCount` are)
  // Fix Wave 2 F3: this verb (read-primary/peek-primary, the one
  // `hooks/lib/devswarm-wake.js` actually routes the Primary through) never
  // tracked forwardable-row gap withholding at all — only `inbox count/read/
  // ack` did (foldSiblingGapRows, ~line 1408) — so the two surfaces silently
  // disagreed (F2's own root cause). Declared here, populated in the sibling
  // merge loop below via the same shared fold.
  let meshGapWithheldCount = 0;
  // meshNeverReadWithheldCount (NEVER_READ_SIBLING_CAP) — see that constant's
  // own header comment. Distinct from meshGapWithheldCount: a gap-withheld
  // row sits AFTER a non-forwardable row in an ALREADY-partially-read
  // sibling's window; a never-read-withheld row is withheld purely because
  // this is the sibling's FIRST-EVER union read and it exceeded the bounded
  // prefix, independent of forwardability.
  let meshNeverReadWithheldCount = 0;
  // Which sibling partition ids the cap actually withheld from, so the report
  // below can name the exact `inbox messages <id>` command that reads the rest
  // (Wave 9 (c): a bare count told a caller something was held back but not how
  // to reach it — and on a non-ackable partition "just call again" is wrong).
  const meshNeverReadCappedIds = [];
  // P1b: set ONLY when registry/group enumeration itself THREW (could not
  // determine whether siblings exist) — distinct from "resolved cleanly, no
  // siblings found" (meshUnionActive stays false, silently — that's fine).
  let meshGroupUnresolved = false;
  let meshGroupError = null;
  // P1a: cursor-write failures for the sibling-store and NDJSON-descriptor
  // channels (never the caller's own primary store cursor, which throws
  // loud/unswallowed as before). Named per partition/channel so the RESULT
  // can honestly report persistence failure even though delivery (the safe,
  // fail-open direction) always succeeds regardless.
  const cursorWriteFailures = [];
  // Wave 6 P0 fix (live-sibling ack gate): a mesh partition belonging to a
  // DIFFERENT LIVE session must never have its cursor written by THIS
  // caller's read-primary/ack. Two live children sharing one canonical
  // worktree (canonicalMeshId groups purely on worktree path — no liveness
  // check, meshCandidateRows above) were silently acking each other's mail:
  // whichever child called read-primary first advanced the SIBLING's own
  // cursor, so the sibling's own next read saw its own backlog as already
  // consumed. `messages` (built earlier, before this ack loop) already
  // contains every sibling row regardless of liveness — visibility is
  // unaffected by this gate; only the cursor WRITE below is conditional.
  // Genuinely orphaned/dead siblings (the legitimate mesh-drain case this
  // ack loop exists for) are NOT protected — they still get drained+acked.
  const liveSiblingsSkipped = [];
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
      const ownEntry = resolveMeshTarget(s, caller, home);
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
          // D11-A (d35d2d4b241e): ADDITIVE — surface callerIdentityDetailed's
          // `kind` (resolved/declared/unresolvable) alongside the existing
          // `callerIdentity` string, never replacing it.
          identity: { id: caller, kind: callerKind },
        };
      }
    }
    total = s.messageCount(id); // STORE-side total only — feeds the STORE cursor ack below, unchanged.
    messages = s.listMessages(id, { sinceCursor: unreadOnly ? cursor : 0 });
    // ASYMMETRIC PARTITION RESOLUTION fix (P0): `send --to-primary` resolves
    // DYNAMICALLY across every registry row sharing this worktree's
    // canonicalMeshId (resolveMeshTarget/meshCandidateRows, ~line 4849) and
    // picks whichever row is freshest-LIVE — but this read path resolved
    // STATICALLY to the ONE `id` the parent-gate hook computed
    // (installIngest.primaryWorkspaceId), which can be a DIFFERENT registry
    // row than the one a given `send` actually delivered into (proven live:
    // a DevSwarm-native builder-id UUID row + anti-hall's minted
    // primary-<hash> row for the SAME worktree — sends landed on the UUID
    // partition, `read-primary` only ever opened the hash partition).
    // `canonicalMeshId`/`groupRegistryByMeshId` already know both rows are
    // ONE logical target (`diagnose` reports them under a single
    // `meshTargets` entry) — resolveMeshPartitionIds() (shared with
    // count/read/ack below, and with peek-primary/read-primary via this same
    // call site — no parallel reimplementation) widens the READ to every row
    // in the group.
    //
    // defect 27cd80902435 (this change): the resolution used to be gated on
    // `wantsUnion` (read-primary/peek-primary/--ack only), leaving a plain
    // `inbox messages <id>` on a SINGLE partition even when `id` belongs to a
    // multi-row mesh group — the exact gap this defect's final ruling names.
    // Resolution now always runs; only the (separate, unrelated) NDJSON
    // descriptor-channel union below stays scoped to wantsUnion. Fail-open:
    // any resolution error leaves meshPartitionIds at just [id] — identical
    // to the pre-fix single-partition read.
    let meshPartitionIds = [String(id)];
    let meshUnionActive = false;
    {
      const selfRow = (s.listRegistry() || []).find((r) => r && String(r.id) === String(id));
      const wtPath = (selfRow && selfRow.worktreePath) || (desc && desc.worktreePath) || null;
      const resolved = resolveMeshPartitionIds(s, id, wtPath);
      meshPartitionIds = resolved.meshPartitionIds;
      meshUnionActive = resolved.meshUnionActive;
      // P1b fix: a THROWN resolution (not "resolved cleanly, no siblings
      // exist") used to be indistinguishable from the clean case, so a
      // caller saw ok:true and a total that LOOKED complete while sibling
      // unread mail was actually omitted because enumeration itself failed
      // (corrupt registry read, canonicalMeshId throw, etc). Surface it
      // instead: narrowing is still the correct FALLBACK for delivery (fail
      // toward `[id]`, never toward blocking the read), but the failure must
      // be visible so a caller doesn't mistake a partial read for a complete
      // one.
      if (resolved.meshGroupUnresolved) {
        meshGroupUnresolved = true;
        meshGroupError = resolved.meshGroupError;
      }
    }
    // __srcId/__srcIdx (defect 8d0a66cfc563, internal-only, stripped before
    // return below): identifies which delivery source each row came from and
    // its position within that source's OWN natural (positional) order — the
    // cap step further down needs this to truncate each source by a genuine
    // structural PREFIX, never an arbitrary subset, so a partition/channel's
    // cursor can never be advanced past a row the cap withheld. Tagged
    // whenever wantsUnion OR the mesh group actually widened (meshUnionActive)
    // — a plain `inbox messages <id>` with NO sibling partitions stays
    // byte-for-byte untagged-then-stripped (identical output), but one WITH
    // siblings now needs the same tag/cap/strip machinery read-primary uses.
    if (wantsUnion || meshUnionActive) messages = messages.map((r, i) => Object.assign({}, r, { __srcId: 'own', __srcIdx: i }));
    // meshSiblingPartitions: each OTHER row's own read-cursor + unread slice,
    // tagged with its OWN partitionId so ack (below) can advance exactly that
    // partition's own cursor file — "per-partition cursors stay per-
    // partition". Empty (a no-op) whenever meshUnionActive is false, so the
    // single-row-Primary path below is byte-for-byte unaffected.
    const meshSiblingPartitions = [];
    if (meshUnionActive) {
      for (const pid of meshPartitionIds) {
        if (pid === String(id)) continue; // `id`'s own slice is already `total`/`messages` above
        const pCursorPath = primaryCursorPath(home, pid);
        // P0 (v0.90.1): size from MAX(cursors/<pid>.json, store cursor) — the
        // two namespaces diverge whenever foldOne/reap-orphans advanced only the
        // store side, and reading the JSON one alone re-delivered the whole
        // already-folded backlog on every call. See siblingBaseCursor.
        const pCursor = siblingBaseCursor(s, home, pid);
        // Ackability decided BEFORE the window is sized (it was computed after,
        // below) — it now selects the cursor namespace this window is measured
        // against, not just how the cap slices.
        const pAckable = doAck && !siblingAckGate(s, id, pid, home, ctx.now);
        // LIVE-SIBLING WATERMARK (P0): a sibling this caller may not ack
        // advances NO cursor at all, so its unread backlog was re-delivered
        // identically on every read, forever. This caller-scoped watermark
        // records how far THIS caller has been shown of THAT sibling, leaving
        // the sibling's own cursors untouched (its own reader still sees 100%).
        // R14 F1 (P2) — THE WATERMARK IS CONSULTED UNCONDITIONALLY, INCLUDING
        // FOR AN ACKABLE SIBLING. `pAckable ? 0 : ...` was correct for the two
        // STEADY states (a permanently-live twin is never ackable and rides the
        // watermark; a never-live sibling has no watermark to read) but wrong at
        // the LIVE->DEAD TRANSITION, which is the common case: while the twin
        // lived this caller drained it to watermark W with the twin's own cursor
        // left at 0; the moment the twin dies siblingAckGate starts permitting
        // acks, pAckable flips true, the watermark is discarded, and the window
        // re-opens at cursor 0 — re-delivering the ENTIRE already-consumed
        // backlog once. Reading it always is strictly safe: the watermark only
        // ever records rows THIS caller was already shown, so max() with the
        // real cursor can never skip an undelivered row, and for a sibling with
        // no watermark file readSiblingSeenCursor returns 0 (a no-op max).
        const pSeen = readSiblingSeenCursor(home, id, pid);
        const pSince = Math.max(pCursor, pSeen);
        const pTotal = s.messageCount(pid);
        let pTailCapped = false;
        let pMessages = s.listMessages(pid, { sinceCursor: unreadOnly ? pSince : 0 })
          .map((r, i) => Object.assign({ partitionId: pid }, r, { __srcId: 'sibling:' + pid, __srcIdx: i }));
        // NEVER_READ_SIBLING_CAP (see constant's header) — cap a sibling's own
        // contribution so a huge backlog cannot dump unboundedly into one call.
        //
        // WAVE 9 (two corrections to the original `pCursor === 0` form):
        //
        // (1) GATE ON BACKLOG SIZE, NOT FIRST-READ. `pCursor === 0` was a proxy
        //     for "this whole history just came out of sinceCursor:0", but the
        //     hazard is the SIZE of what this call is about to merge/ts-sort,
        //     which has nothing to do with whether the partition was ever read.
        //     A partition read once and then left to accumulate was completely
        //     unbounded on call #2 (measured: 350 rows delivered where the cap
        //     is 200). The size test alone (`pMessages.length > CAP`) covers
        //     both, and it is strictly more conservative — every case the old
        //     gate caught, this catches too.
        //
        // (2) A PARTITION THIS CALL CANNOT ACK GETS THE NEWEST ROWS, NOT A
        //     FROZEN PREFIX. The constant's header justifies the earliest-first
        //     PREFIX by the invariant "the withheld tail is reachable on the
        //     NEXT call, because this call acks only what it delivered". That
        //     invariant needs an ACK. A LIVE foreign sibling is never acked at
        //     all (siblingAckGate, Fix Wave 6/7) and a non-ack read (`doAck`
        //     false) acks nothing either — so `pCursor` stays put, the cap
        //     re-fires identically every call, and the caller is handed the
        //     SAME oldest CAP rows forever while everything past them is
        //     permanently invisible to `read-primary`. For those partitions the
        //     cap keeps the NEWEST rows instead (`slice(-CAP)`): the newest mail
        //     is what a live peer's reader actually needs, and the header's own
        //     objection to a tail ("skipping over untouched middle rows, which
        //     this file's ack math cannot express") does not apply precisely
        //     BECAUSE no cursor is written for such a partition — `tailCapped`
        //     is carried on the part and the ack loop hard-refuses it, so the
        //     tail can never be combined with an ack even if liveness flipped
        //     between here and there. Nothing is lost either way: the store rows
        //     are untouched and every withheld row stays readable directly, which
        //     is what `neverReadCapHint` (emitted below) names.
        //
        // P0 (v0.90.1) AMENDMENT TO (2): the tail form's whole justification —
        // "no cursor is written for such a partition" — no longer holds for an
        // ACKING read. A non-ackable sibling now advances the CALLER-SCOPED
        // watermark instead (see pSeen above), so this call DOES have somewhere
        // safe to record progress and the prefix form is both valid and
        // necessary: the tail form would hand back the same newest CAP rows
        // forever while the watermark could never legally move past them.
        // The tail form is kept EXACTLY as-is for a NON-acking read (`peek`),
        // which writes no watermark and therefore still has no way to advance.
        if (unreadOnly && pMessages.length > NEVER_READ_SIBLING_CAP) {
          meshNeverReadWithheldCount += pMessages.length - NEVER_READ_SIBLING_CAP;
          meshNeverReadCappedIds.push(pid);
          // pPrefixCapped: this call has SOMEWHERE to record progress for this
          // partition — a real cursor (pAckable) or, for a live sibling on an
          // acking read, the caller-scoped watermark (doAck). Either way the
          // cap must be a structural PREFIX, because both advance positionally.
          const pPrefixCapped = pAckable || doAck;
          if (pPrefixCapped) {
            pMessages = pMessages.slice(0, NEVER_READ_SIBLING_CAP); // structural PREFIX — the ack (or watermark) advances exactly this far
          } else {
            pTailCapped = true;
            // Re-index the kept tail into a contiguous 0..n-1 __srcIdx space:
            // the general cap step below reasons in "prefix by __srcIdx", so a
            // kept window must present itself as one. Safe only because this
            // partition is never acked (see above) — the indices no longer map
            // to physical offsets, and nothing downstream may use them to move
            // a cursor.
            pMessages = pMessages.slice(-NEVER_READ_SIBLING_CAP).map((r, i) => Object.assign({}, r, { __srcIdx: i }));
          }
        }
        meshSiblingPartitions.push({ id: pid, cursorPath: pCursorPath, cursor: pCursor, sinceCursor: pSince, ackable: pAckable, total: pTotal, messages: pMessages, tailCapped: pTailCapped });
        meshAddedTotal += pTotal;
      }
    }
    // defect dca4d2e16926: fold in the NDJSON descriptor channel, using the
    // SAME `unionUnread` primitive `inbox count/read/ack` already use (not a
    // parallel reimplementation). `storeHandle: s` lets unionUnread dedupe the
    // store's own unread rows against NDJSON hashes internally — a message
    // present in BOTH channels (native-drained) is returned only once, on the
    // NDJSON side (union.storeOnlyUnreadRows already excludes it).
    if (wantsUnion && desc && desc.inboxPath) {
      try {
        union = devswarmUnread.unionUnread({ inboxPath: desc.inboxPath, cursorPath: desc.cursorPath, id, storeHandle: s });
      } catch (_) { union = null; } // fail-open: falls back to store-only reporting below
    }
    if (union) {
      // Merge the two channels into ONE `messages` array, ordered by ts
      // (ascending) so mail interleaves chronologically regardless of which
      // channel carried it — deterministic (Array#sort is stable; a tied/
      // missing ts keeps NDJSON-before-store, its concat order below).
      const ndjsonRows = union.ndjsonUnreadLines.map((line, i) => {
        let o = null;
        try { o = JSON.parse(line); } catch (_) { o = null; }
        const p = (o && typeof o === 'object') ? o : {};
        return {
          origin: 'ndjson',
          __srcId: 'ndjson', __srcIdx: i,
          ts: Number.isFinite(p.createdAt) ? p.createdAt : null,
          hash: p._h != null ? String(p._h) : null,
          body: p.message != null ? String(p.message) : '',
          sender: p.fromBranch != null ? String(p.fromBranch) : null,
          status: p.status != null ? p.status : null,
        };
      });
      const storeRows = union.storeOnlyUnreadRows.map((r, i) => Object.assign({ origin: 'store' }, r, { __srcId: 'own', __srcIdx: i }));
      messages = ndjsonRows.concat(storeRows).sort((a, b) => {
        const ta = Number.isFinite(a.ts) ? a.ts : Number.POSITIVE_INFINITY;
        const tb = Number.isFinite(b.ts) ? b.ts : Number.POSITIVE_INFINITY;
        return ta - tb;
      });
    }
    // P0 fix (adversarial review): fold in the mesh siblings' unread slices.
    // The PRIOR version deduped cross-partition rows on a WEAK content key
    // (sender, ts, body) -- two GENUINELY DISTINCT messages (different sends,
    // different recipients) that merely happened to share sender+ts+body
    // collapsed into one, and the ack loop below then advanced BOTH
    // partitions' cursors past the suppressed twin, losing it permanently.
    //
    // Identity investigated: `hash` (meshMessageHash, companion/lib/
    // devswarm-store.js:285) hashes {from, to, type, urgency, message,
    // timestamp[, needsReply]} -- `to` (the partition) is IN the hash, and
    // `hash` carries a STORE-WIDE `UNIQUE(hash)` constraint across every
    // workspace_id in one store (devswarm-store.js CREATE TABLE messages,
    // ~line 414). Two rows in DIFFERENT partitions can therefore never share
    // a hash by construction, and a row's workspace_id is fixed at insert
    // time so the SAME physical row can never come back from two different
    // partitions' listMessages() calls either. There is no schema-provable
    // "cross-partition duplicate" case at all -- so nothing here is provably
    // identical, and per the governing principle (never lose a message;
    // at-least-once beats at-most-once) NOTHING is suppressed: every sibling
    // row is delivered. `hash` is still used below as a defensive,
    // belt-and-suspenders guard (mirrors devswarmUnread.unionUnread's own
    // `!r.hash || !hashes.has(r.hash)` convention -- a null hash is NEVER
    // treated as a match) against a theoretical sha256 collision; it cannot
    // fire in practice given the constraint above.
    if (meshSiblingPartitions.length) {
      // defect 64861a623503: seed from CONSUMED history too, not just from the
      // rows still unread in this window — a forwarded copy of a message the
      // caller already handled has nothing left in `messages` to match against.
      // `union` is null whenever the union read itself failed (see its own
      // fail-open catch above), so the cursor is read from the store directly
      // as the fallback — never dereferenced off a possibly-null union.
      let ownStoreCursor = 0;
      try { ownStoreCursor = union ? union.storeCursor : s.cursorValue(id); } catch (_) { ownStoreCursor = 0; }
      const seed = consumedDedupSeed(s, id, ownStoreCursor, CONSUMED_HASH_SEED_CAP);
      const seenHashes = seed.hashes;
      // R13 item 11: seed the ORIGINAL's identity too, not just the copy's own
      // re-addressed hash — `consumedDedupSeed` above already does exactly this
      // for consumed history (`forwardedOrigHashOf`), and this loop was the one
      // place the pair diverged. It matters because a fold copy sitting in the
      // caller's OWN partition and the ORIGINAL still sitting in the sibling's
      // partition are the SAME logical message, delivered in the SAME call:
      // measured on the repro, 5 new rows came back as 10 (5 own copies + 5
      // sibling originals). Seeding only `m.hash` could never match them,
      // because the forward re-addresses the row and therefore re-hashes it.
      for (const m of messages) {
        if (!m) continue;
        if (m.hash) seenHashes.add(m.hash);
        const oh = forwardedOrigHashOf(m);
        if (oh) seenHashes.add(oh);
      }
      const seenLogical = seed.logical;
      const dedupedSiblingRows = [];
      // HARD INVARIANT (structural, not conventional): each sibling's actual
      // delivered count is recorded on `part.deliveredCount` here, and the
      // ack loop below derives that partition's cursor target FROM THIS
      // NUMBER -- never from `part.total` directly. A row suppressed by the
      // defensive hash guard above therefore structurally cannot have its
      // partition's cursor advanced past it, regardless of how that
      // suppression happened.
      //
      // Fix Wave 2 F3/F1: delegated to foldSiblingGapRows (shared with `inbox
      // count/read/ack`, ~line 1408) — this loop used to deliver EVERY
      // sibling row (hash-dedup only), with no forwardable-row gap tracking
      // at all, while `inbox count/read/ack` grew its own (differently-
      // behaved) version of the same mechanism. Both surfaces now share one
      // fold, so they can no longer silently disagree. `part.deliveredCount`
      // remains a genuine index-based PREFIX of `part.messages` (never
      // `part.total`), which is what the ack loop below (and the
      // `withheldBySource` cap-subtraction it also applies) depends on.
      for (const part of meshSiblingPartitions) {
        const folded = foldSiblingGapRows(part.messages, seenHashes, seenLogical);
        meshGapWithheldCount += folded.gapWithheldCount;
        for (const row of folded.deliveredRows) {
          dedupedSiblingRows.push(row);
        }
        part.deliveredCount = folded.deliveredCount;
        // G1/G2 fix: `consumedThrough` lets the ack loop below derive the
        // PHYSICAL row count to advance past for however many of this
        // partition's leading `deliveredRows` actually survive the P2-D cap
        // — see foldSiblingGapRows's own header comment (~line 1437).
        part.consumedThrough = folded.consumedThrough;
        part.consumedCount = folded.consumedCount;
      }
      meshAddedUnreadCount = dedupedSiblingRows.length;
      if (dedupedSiblingRows.length) {
        // Deterministic ordering: concat in a fixed (id-first, then
        // meshPartitionIds order) sequence, THEN a stable sort by ts -- Node's
        // Array#sort is a stable sort (ES2019+), so a tied/missing ts keeps
        // this concat order as its tiebreak, never an arbitrary one.
        messages = messages.concat(dedupedSiblingRows).sort((a, b) => {
          const ta = Number.isFinite(a.ts) ? a.ts : Number.POSITIVE_INFINITY;
          const tb = Number.isFinite(b.ts) ? b.ts : Number.POSITIVE_INFINITY;
          return ta - tb;
        });
      }
    }
    // UNBOUNDED-READ CAP (defect 8d0a66cfc563): the merge above has no limit —
    // truncate the FINAL merged set to `inboxReadLimit`, but per-SOURCE (own
    // store / ndjson / each sibling partition) rather than a blind slice of
    // the ts-sorted array, so every source's kept rows stay a genuine
    // structural PREFIX of that source's own natural order. This is the
    // property the ack-cursor math below (and the sibling ack's pre-existing
    // `deliveredCount` invariant) depends on: a withheld row's own
    // partition/channel cursor must never advance past it. Naively slicing
    // the ts-sorted `messages` array would NOT guarantee this — a tied/
    // reordered ts could keep a source's row N while dropping its row N-1.
    // (defect 27cd80902435) Gated on `wantsUnion || meshUnionActive` — the
    // widened mesh case now needs the same cap `read-primary` always had.
    if ((wantsUnion || meshUnionActive) && messages.length > inboxReadLimit) {
      const naiveKept = new Set(messages.slice(0, inboxReadLimit));
      // For each source, find the smallest __srcIdx among that source's rows
      // NOT in naiveKept — every row of that source AT OR AFTER that index is
      // withheld too, even if the ts-sort happened to place it earlier in
      // `messages` than the true gap. This makes the kept set a provable
      // prefix by __srcIdx, independent of ts ordering.
      const minWithheldIdxBySource = new Map();
      for (const row of messages) {
        if (!row || row.__srcId === undefined) continue;
        if (naiveKept.has(row)) continue;
        const cur = minWithheldIdxBySource.has(row.__srcId) ? minWithheldIdxBySource.get(row.__srcId) : Infinity;
        if (row.__srcIdx < cur) minWithheldIdxBySource.set(row.__srcId, row.__srcIdx);
      }
      const kept = [];
      withheldBySource = new Map();
      for (const row of messages) {
        const minIdx = (row && row.__srcId !== undefined && minWithheldIdxBySource.has(row.__srcId))
          ? minWithheldIdxBySource.get(row.__srcId) : Infinity;
        if (row && row.__srcIdx !== undefined && row.__srcIdx >= minIdx) {
          withheldBySource.set(row.__srcId, (withheldBySource.get(row.__srcId) || 0) + 1);
        } else {
          kept.push(row);
        }
      }
      truncatedCount = messages.length - kept.length;
      messages = kept;
    }
    // Own-store ack target derivation (P0 MESSAGE-LOSS fix): captured HERE,
    // before the tag-strip below removes `__srcId`/`.index`'s identifying
    // context. ROOT CAUSE this replaces: the NDJSON union filters store rows
    // BY HASH (devswarm-unread.js unionUnread — `storeUnreadRows.filter(r =>
    // !r.hash || !unreadNdjsonHashes.has(r.hash))`), so `union.
    // storeOnlyUnreadRows` (and therefore the `storeRows` built from it,
    // ~line 3567) can have GAPS relative to the raw store-unread sequence
    // (a deduped row is simply absent, neither kept nor withheld). The cap's
    // `withheldBySource.get('own')` count is then a count over THAT
    // gapped/filtered index space, while `total` (s.messageCount, above) is
    // a count over the RAW store sequence — `total - ownWithheldCount`
    // silently assumed every non-withheld raw slot (including a
    // deduped-away gap) was delivered, over-advancing the cursor past
    // messages that were never returned to the caller (proven counterexample:
    // raw unread 101..105, NDJSON dedups 103, cap keeps only 101 -> old
    // formula yields 102 as "acked" though 102 was withheld, never
    // delivered, and permanently lost on the next read).
    //
    // Fix: derive the target from the ACTUAL delivered row's raw position,
    // not by arithmetic. Every store row carries `.index` — a real,
    // database-backed ABSOLUTE 1-based position within that workspace's full
    // message history (devswarm-store.js listMessages), stable across every
    // caller/filter that reads it. The safe cursor is simply the highest
    // `.index` among the 'own'-source rows actually present in `messages`
    // after capping (never lower than the pre-read `cursor`, so an ack with
    // nothing delivered this call never regresses it). This is structurally
    // safe by construction — the cursor can only ever be set to the position
    // of a row that was truly returned, so it cannot advance past a
    // withheld or deduped-away row regardless of which index space produced
    // the withholding.
    let ownDeliveredMaxIndex = null;
    for (const row of messages) {
      if (row && row.__srcId === 'own' && Number.isFinite(row.index)
        && (ownDeliveredMaxIndex === null || row.index > ownDeliveredMaxIndex)) {
        ownDeliveredMaxIndex = row.index;
      }
    }
    // Strip the internal tags before this array reaches the caller — they
    // were never part of the wire contract. (defect 27cd80902435: same
    // wantsUnion || meshUnionActive gate as the tag-apply/cap steps above.)
    if (wantsUnion || meshUnionActive) {
      messages = messages.map((r) => {
        if (!r || (r.__srcId === undefined && r.__srcIdx === undefined)) return r;
        const c = Object.assign({}, r);
        delete c.__srcId;
        delete c.__srcIdx;
        return c;
      });
    }
    if (doAck) {
      // Own-store ack target: `ownDeliveredMaxIndex` (computed above, before
      // the tag strip) is the raw absolute `.index` of the last 'own'-source
      // row actually delivered in `messages` — never regress below `cursor`
      // (a call that delivered nothing own-side must not move the cursor).
      // See the P0 MESSAGE-LOSS fix comment above for why this replaces the
      // prior `total - ownWithheldCount` subtraction.
      const ownTarget = ownDeliveredMaxIndex !== null ? Math.max(cursor, ownDeliveredMaxIndex) : cursor;
      acked = inboxCursor.ackTo(cursorPath, ownTarget); // absolute set to the last actually-delivered own row's raw position (no inbox clamp)
      s.setCursor(id, acked); // keep deriveSummary's unread projection in sync with the ACK
      // Per-partition cursors STAY per-partition: each sibling row is acked,
      // and ONLY the rows actually in `meshSiblingPartitions` (the group `id`
      // resolved to this call) — a partition outside the group, or one this
      // call never touched, is never written.
      //
      // P0 HARD INVARIANT (structural): the ack target is
      // `part.cursor + part.deliveredCount` — deliveredCount is the actual
      // number of that partition's rows folded into `messages` above, NEVER
      // `part.total` directly. In the normal (nothing suppressed) case this
      // is arithmetically identical to `part.total` (part.messages was
      // fetched with sinceCursor:part.cursor and unreadOnly is always true on
      // an ack call, so part.cursor + part.messages.length === part.total
      // exactly) — but if a future change (or the defensive hash guard above)
      // ever DOES suppress a row, the cursor for that partition structurally
      // cannot advance past it, because the target is computed FROM what was
      // delivered, not from the partition's raw count.
      //
      // P1a fix: a cursor-write failure here used to be silently swallowed —
      // delivery had already happened (the safe, fail-open direction; a
      // redelivered message next read is the expected/safe outcome), but
      // `ok:true` gave no signal that the SIDE EFFECT (the ack) didn't
      // persist. Name which partition/channel failed and why, matching
      // reconcile's own per-target `results[].error` convention (cmdReconcile,
      // ~line 6061).
      for (const part of meshSiblingPartitions) {
        // TAIL-CAP HARD REFUSAL (Wave 9 (c)): this partition was capped to its
        // NEWEST rows because the read decided it could not be acked. Its
        // delivered rows are therefore NOT a structural prefix of its unread
        // sequence, and `part.cursor + physicalConsumed` would mark rows read
        // that were never delivered. Refuse the ack outright — never re-derive
        // the decision here. (Belt-and-braces: the gate below reaches the same
        // verdict from the same inputs; this makes the two structurally
        // incapable of disagreeing if liveness flipped in between.)
        // (A tail-capped part is also watermark-ineligible for the SAME reason
        // — its delivered rows are not a prefix — so this stays a hard skip.)
        if (part.tailCapped) { liveSiblingsSkipped.push(part.id); continue; }
        // LIVE-SIBLING GATE (Fix Wave 7 Item 2): skip the cursor write (never
        // the delivery — `part` is already in `messages`) unless we have
        // POSITIVE evidence the partition's owner is dead, not merely absent
        // evidence of life. `hasFreshHeartbeat` ALONE (the Wave 6 gate) misread
        // a child mid-long-turn, a never-yet-heartbeated child, and an
        // EACCES-on-heartbeat child as dead — see siblingAckGate's own header
        // and companion/lib/liveness.js's isSiblingPartitionLive for the full
        // composition (fresh heartbeat OR a real session with no positively-
        // stale activity -> live). Shared with `inbox ack`'s own sibling loop
        // via `siblingAckGate` so the two verbs cannot diverge.
        //
        // P0 (v0.90.1): a skipped sibling is no longer a DEAD END. Its rows
        // were still delivered to this caller, and with nothing recorded
        // anywhere they were re-delivered on every subsequent read forever.
        // The partition's own cursors stay untouched (the gate's whole point),
        // but this caller records how far IT has been shown, in its own
        // caller-scoped watermark file. Computed from the SAME physical
        // `part.sinceCursor + physicalConsumed` arithmetic the real ack below
        // uses — never a second derivation.
        const notAckable = siblingAckGate(s, id, part.id, home, ctx.now);
        if (notAckable) liveSiblingsSkipped.push(part.id);
        const fullDeliveredCount = Number.isFinite(part.deliveredCount) ? part.deliveredCount : part.messages.length; // fold's own full, pre-cap count — never mutated below
        let deliveredCount = fullDeliveredCount;
        // defect 8d0a66cfc563: subtract whatever the cap withheld from THIS
        // partition specifically — same structural guarantee as the hash-
        // dedup guard above (the ack target is derived from what was
        // actually delivered, never from a raw count).
        if (withheldBySource) deliveredCount -= (withheldBySource.get('sibling:' + part.id) || 0);
        // Fix Wave 3 G1/G2 (P0/P1): the ack target must be the PHYSICAL row
        // count the (possibly cap-truncated) `deliveredCount` corresponds
        // to, not `deliveredCount` itself — a corrupted/null row or an
        // exact-hash duplicate can be resolved (consumed) WITHOUT being
        // delivered, so `deliveredCount` alone can undercount the physical
        // prefix (permanently wedging a corrupt-row partition, G1) or point
        // at the wrong physical offset (G2). When nothing was capped for
        // this partition (`deliveredCount === fullDeliveredCount`), use the
        // fold's own full `consumedCount` — it also covers any TRAILING
        // consumed-but-undelivered row (e.g. a dedup after the last
        // delivered row, before any gap trigger) that `consumedThrough`'s
        // per-delivered-row snapshot cannot see. Otherwise, use
        // `consumedThrough[k - 1]`, the physical count consumed to produce
        // the first `k` delivered rows. Fall back to `deliveredCount` itself
        // when neither is available (fail-open — never worse than pre-fix).
        // NOTE: the "nothing capped for this partition" check MUST run
        // BEFORE the `deliveredCount <= 0` short-circuit — G1's exact wedge
        // case has `deliveredCount === 0 === fullDeliveredCount` (nothing
        // delivered AND nothing capped, e.g. a `[hole]`-only window), and
        // that case still needs `part.consumedCount` (1, the hole itself),
        // not a hard 0.
        // `part.sinceCursor` is where THIS window actually started reading
        // (max of the two cursor namespaces, and — for a non-ackable sibling —
        // of this caller's watermark). `part.cursor` is retained for the ack
        // path so an ackable partition's real cursor math is unchanged.
        // R14 F1 (P2), SECOND HALF (`ackAnchor`, at the end of this block) — the
        // ack target is anchored on `part.sinceCursor`, WHERE THIS WINDOW
        // ACTUALLY STARTED READING, not on `part.cursor`. `physicalConsumed`
        // counts rows from the FRONT OF THE WINDOW (listMessages was called with
        // `sinceCursor: pSince`), so adding it to `part.cursor` is only correct
        // when the two are equal. They diverge exactly at the live->dead
        // transition the watermark half fixes: the window starts at the
        // watermark W while the sibling's own cursor is still 0, so
        // `part.cursor + n` acks n instead of W + n — leaving the
        // watermark-skipped rows permanently unacked and re-delivered on the
        // next read. The two halves MUST ship together: the watermark half alone
        // re-opens this under-ack. For every other partition
        // `sinceCursor === cursor` by construction (pSince = max(pCursor, 0)),
        // so this is a no-op there.
        const consumedThrough = Array.isArray(part.consumedThrough) ? part.consumedThrough : null;
        const physicalConsumed = (deliveredCount >= fullDeliveredCount && Number.isFinite(part.consumedCount))
          ? part.consumedCount
          : (deliveredCount <= 0
            ? 0
            : (consumedThrough && Number.isFinite(consumedThrough[deliveredCount - 1])
              ? consumedThrough[deliveredCount - 1]
              : deliveredCount));
        const ackAnchor = Number.isFinite(part.sinceCursor) ? Math.max(part.cursor, part.sinceCursor) : part.cursor;
        const ackTarget = ackAnchor + physicalConsumed;
        if (notAckable) {
          const seenTarget = (Number.isFinite(part.sinceCursor) ? part.sinceCursor : part.cursor) + physicalConsumed;
          // D11-A (TOCTOU fix): serialize against the read+conditional-unlink
          // below under the SAME per-(callerId,siblingId) lock — see
          // withWatermarkLock's header.
          if (seenTarget > 0 && !withWatermarkLock(id, part.id, home, () => writeSiblingSeenCursor(home, id, part.id, seenTarget))) {
            cursorWriteFailures.push({ partitionId: part.id, channel: 'sibling-seen-watermark', error: 'could not write caller-scoped seen watermark' });
          }
          continue; // the sibling's OWN cursors are never touched for a live twin
        }
        try {
          inboxCursor.ackTo(part.cursorPath, ackTarget);
          s.setCursor(part.id, ackTarget);
          // R14 F1, THIRD HALF — retire the watermark once its rows are covered
          // by the sibling's OWN durable cursors. The watermark exists only to
          // stand in for a cursor that could not be advanced; keeping it after a
          // real ack leaves a stale file that outlives the sibling (R14 F3's
          // hygiene problem) and a second, redundant floor on every later read.
          // Deleted only AFTER both real cursor writes succeeded, and only when
          // the ack actually covers it — a partial ack keeps the watermark.
          //
          // R15 P3 FIX: the prior guard compared `ackTarget` against
          // `part.sinceCursor` — but `ackTarget = max(part.cursor,
          // part.sinceCursor) + physicalConsumed`, which is ALGEBRAICALLY >=
          // `part.sinceCursor` for any `physicalConsumed >= 0`. The comparison
          // was a tautology: always true, so the watermark was deleted
          // unconditionally on every successful ack, never actually gated on
          // "did this ack cover it". Re-read the RAW persisted watermark value
          // from disk (not the in-memory `part.sinceCursor` captured earlier in
          // this same read, which cannot reflect a concurrent writer bumping
          // the file in between) and test the real invariant via
          // `siblingWatermarkCovered` — pulled into its own predicate so the
          // comparison is directly unit-testable, not only reachable through a
          // full CLI race no single-process test can reproduce.
          //
          // D11-A (TOCTOU fix): the read (readSiblingSeenCursor) -> conditional
          // unlink (removeSiblingSeenCursor) below used to run completely
          // unlocked — a concurrent writeSiblingSeenCursor for this SAME
          // (callerId, siblingId) pair (the notAckable branch above, from a
          // second overlapping invocation) could land its write in the gap
          // and lose that extension when the unlink fired. Both this
          // read+unlink AND that write now serialize under the SAME
          // per-(callerId,siblingId) lock (withWatermarkLock) — whichever
          // caller wins the lock completes atomically w.r.t. the other.
          withWatermarkLock(id, part.id, home, () => {
            const freshWatermark = readSiblingSeenCursor(home, id, part.id);
            if (siblingWatermarkCovered(ackTarget, freshWatermark)) {
              removeSiblingSeenCursor(home, id, part.id);
            }
          });
        } catch (e) {
          cursorWriteFailures.push({ partitionId: part.id, channel: 'sibling-store-cursor', error: String((e && e.message) || e) });
        }
      }
      store.deriveSummary(s, { home, env: ctx.env, now: ctx.now }); // refresh the persisted projection now
      // Advance the NDJSON descriptor's OWN cursor too (a THIRD, separate
      // cursor file from primaryCursorPath/the store cursor above) — mirrors
      // the ack-all path `inbox ack <id>` already performs (below, ~line
      // 3521). Without this, `read-primary` would durably consume the
      // NDJSON-channel messages it just returned in `messages` above while
      // never marking them read on the NDJSON side, so they would resurface
      // as "unread" on the next `inbox count`/`peek-primary`/`read-primary`
      // forever. Best-effort/fail-open on DELIVERY (the store-side ack above
      // already durably succeeded regardless of this) — but P1a fix: report
      // the persistence failure instead of swallowing it silently.
      if (union && desc && desc.inboxPath && desc.cursorPath) {
        try {
          // defect 8d0a66cfc563: advanceCursor() marks the ENTIRE current
          // inbox file read — correct only when every unread ndjson line was
          // actually delivered. When the cap withheld some, ack only up to
          // what was delivered (union.cursor + kept ndjson lines) so the
          // withheld lines resurface as unread on the next read, exactly
          // like the store-side partitions above.
          const ndjsonWithheldCount = withheldBySource ? (withheldBySource.get('ndjson') || 0) : 0;
          const ndjsonAckTarget = union.cursor + union.ndjsonUnreadLines.length - ndjsonWithheldCount;
          inboxCursor.ackTo(desc.cursorPath, ndjsonAckTarget, undefined, desc.inboxPath);
        }
        catch (e) { cursorWriteFailures.push({ partitionId: id, channel: 'ndjson-cursor', error: String((e && e.message) || e) }); }
      }
    }
  } finally { s.close(); }
  // unreadCount (FIX 2): the actual count of unread messages AS OF the cursor
  // read at the top of this call (before any ack this call itself performs) —
  // a real number, never conflated with `unreadOnly`'s boolean mode. When the
  // NDJSON union is active this is the MERGED unread count (matches `inbox
  // count`'s `unreadTotal`) — union.unread already equals messages.length
  // exactly (ndjsonUnreadLines.length + storeOnlyUnreadRows.length).
  // meshAddedUnreadCount folds in the mesh-partition widening (P0 fix, this
  // change): sibling-partition rows already deduped by content identity
  // against everything else in `messages`, so this is purely additive — 0
  // whenever meshUnionActive was false (single-row Primary, byte-identical).
  const unreadCount = (union
    ? union.unread
    : (Number.isFinite(total) && Number.isFinite(cursor) ? Math.max(0, total - cursor) : 0)) + meshAddedUnreadCount;
  // total: merged (dedup'd) total across both channels when the union is
  // active — matches `inbox count`'s `total` field, closing the exact
  // field-reported mismatch (457 unread via `count` vs 57 via `peek-primary`)
  // this defect describes. Store-only setups (no descriptor / union
  // unavailable) keep the pre-fix store-only total, unchanged. meshAddedTotal
  // (this change) adds each sibling partition's own full message count on
  // top — 0 whenever meshUnionActive was false.
  const outTotal = (union ? union.total : total) + meshAddedTotal;
  // P2 (adversarial review): `count`/`messages.length` is NOT guaranteed to
  // be <= inboxReadLimit. The per-source prefix widening above (~"UNBOUNDED-
  // READ CAP") can only ever WIDEN a source's kept set relative to the naive
  // global ts-sorted slice (it keeps every row of a source below that
  // source's own min-withheld __srcIdx, which is >= that source's count in
  // the naive slice) — summed across sources this can exceed inboxReadLimit.
  // That widening is deliberate and required for correctness (it is what
  // keeps each source's kept set a genuine structural prefix, the property
  // the ack-cursor math depends on) — trading a hard cap for a soft one was
  // judged the safer of the two honest options. The actual contract:
  // `count` may exceed `inboxReadLimit` when `truncated:true` is also set;
  // use `truncatedCount`/`truncated` (below) to detect withholding, not a
  // `count` vs `inboxReadLimit` comparison.
  // WINDOW PROJECTION (--since / --tail, defect 3f6027ee462a). Applied LAST, to
  // the already-delivered row set, and ONLY on the non-acking `inbox messages`
  // verb (windowActive is false everywhere else — the ack-bearing verbs already
  // returned a rejection above). Nothing here touches a cursor, a total, or an
  // ack: `total`/`unreadCount` below keep reporting the REAL untruncated
  // figures, and the withheld rows are still exactly where they were.
  // Rows with no comparable field (`ts`/`index` null — a legacy row) are KEPT
  // by --since rather than dropped: hiding mail because its metadata is missing
  // is the one failure mode a "show me recent mail" flag must never have. They
  // are counted in `windowUndated` so the caller can see it happened.
  let windowWithheld = 0;
  let windowUndated = 0;
  if (windowActive && Array.isArray(messages)) {
    // TAIL-UNDER-TRUNCATION REFUSAL (R11-A3, P2). `--tail N` promises "the
    // NEWEST N". It cannot keep that promise once the per-source read cap
    // above (the `(wantsUnion || meshUnionActive) && messages.length >
    // inboxReadLimit` block) has fired: that cap deliberately keeps an
    // EARLIEST structural PREFIX of every source, so `messages` here is the
    // OLDEST `inboxReadLimit` rows and `slice(-N)` returns the last N of the
    // EARLIEST batch — mail that is arbitrarily far from the newest, silently
    // presented as if it were the tail. Nothing about the ordering can be
    // reversed to fix this: the prefix direction is exactly what the ack
    // arithmetic below (and the sibling `deliveredCount` invariant) depends
    // on — a withheld row's cursor must never advance past it — so keeping a
    // LATEST suffix instead would break cursor safety on every acking caller
    // that shares this function.
    // REFUSING is therefore the only honest option, and it is safe: this verb
    // is non-acking (windowActive is false whenever doAck is set), so nothing
    // has been consumed and re-running with `--since` returns the mail. The
    // hint names `--since` because a since-bounded read narrows the set
    // BEFORE the cap can bite, which is the actual way to reach recent mail
    // on an over-cap partition.
    if (windowTail !== null && truncatedCount > 0) {
      return {
        ok: false,
        action: (opts && opts.action) || 'messages',
        id,
        reason: 'tail-under-truncation',
        truncated: true,
        truncatedCount,
        limit: inboxReadLimit,
        requestedTail: windowTail,
        error: '--tail ' + windowTail + ' cannot be honoured: this read was truncated by the '
          + inboxReadLimit + '-row per-source cap (' + truncatedCount + ' row(s) withheld), and the cap keeps '
          + 'the EARLIEST rows, so the last ' + windowTail + ' of what was read are NOT the newest messages.',
        hint: 'use `--since <index|ISO date>` to bound the read to recent mail before the cap applies '
          + '(or raise --limit above ' + inboxReadLimit + ' so nothing is truncated). Nothing was acked; no mail was lost.',
      };
    }
    const before = messages.length;
    if (windowSince) {
      messages = messages.filter((m) => {
        if (windowSince.kind === 'ts') {
          const t = m && Number(m.ts);
          if (!Number.isFinite(t)) { windowUndated += 1; return true; }
          return t >= windowSince.value;
        }
        const ix = m && Number(m.index);
        if (!Number.isFinite(ix)) { windowUndated += 1; return true; }
        return ix > windowSince.value;
      });
    }
    if (windowTail !== null && messages.length > windowTail) messages = messages.slice(-windowTail);
    // A7 — UNDATED ROWS ON THE TAIL PATH. The merge sort above orders by
    // `Number.isFinite(a.ts) ? a.ts : Number.POSITIVE_INFINITY`, so every row
    // with a missing/non-numeric `ts` (a legacy partition's rows) sorts to the
    // very END — exactly where `slice(-N)` takes from. A single legacy
    // partition can therefore fill the WHOLE tail with rows that are not
    // actually the newest, they are merely undated. `--since` already reports
    // `window.undatedKept` for the same class of row; the tail path was silent
    // about it. Recount over what was ACTUALLY RETURNED (not over what --since
    // kept, which the slice may since have dropped) using the SAME predicate
    // the sort uses, so the number always describes the delivered set. Only
    // runs when --tail is in play — a --since-only read's count is unchanged.
    if (windowTail !== null) {
      windowUndated = messages.filter((m) => !(m && Number.isFinite(m.ts))).length;
    }
    windowWithheld = before - messages.length;
  }
  const out = {
    ok: true,
    action: (opts && opts.action) || (doAck ? 'read-primary' : 'messages'),
    id,
    unreadOnly,
    unreadCount,
    cursor: acked !== undefined ? acked : cursor,
    total: outTotal,
    count: messages.length,
    messages,
  };
  // R23 P2: same promotion-visibility fix as cmdInboxPull — a failed
  // registry write from maybePromoteUnclaimed (descriptor promoted, registry
  // still `unclaimed:`) was previously discarded here entirely. Additive
  // `promotion` object, present only when a promotion happened or the
  // registry write actually failed this call.
  if (promotedInner && (promotedInner.promoted || promotedInner.registryWriteError)) {
    out.promotion = { promoted: !!promotedInner.promoted };
    if (promotedInner.registryWriteError) out.promotion.registryWriteError = promotedInner.registryWriteError;
  }
  if (union) {
    // Additive channel-scoped cursor visibility, naming convention matching
    // `inbox count`'s own cursorNdjson/cursorStore fields (a few hundred
    // lines below) so a caller reading BOTH verbs sees consistent field
    // names for the two distinct cursor files.
    out.cursorNdjson = union.cursor;
    out.cursorStore = union.storeCursor;
  }
  // FIX 5 (zero-progress ack visibility): `ok:true` alone cannot distinguish an
  // ack that actually advanced the cursor from one that moved nothing (e.g. an
  // already-fully-read workspace, or — pre-FIX-5 — an unregistered id that
  // silently acked total:0 -> cursor:0). Report both endpoints explicitly.
  if (doAck) {
    out.ackedFrom = cursor;
    out.acked = acked;
  }
  // P1a: delivery ALWAYS succeeds regardless (fail-open on delivery — a
  // redelivered message next read is the safe direction), but a cursor
  // persistence failure must not hide behind a bare `ok:true`. Named per
  // partition/channel so a caller can see exactly what did not persist.
  if (cursorWriteFailures.length) {
    out.cursorWriteFailures = cursorWriteFailures;
    out.cursorPersisted = false;
  }
  // Live-sibling ack gate visibility (Wave 6): which partitions were
  // delivered (still in `messages`) but NOT ack-written because their owner
  // looked live. Empty/absent whenever no sibling partitions were live.
  if (liveSiblingsSkipped.length) out.liveSiblingsSkipped = liveSiblingsSkipped;
  // P1b: registry/group enumeration THREW (not "resolved cleanly, no
  // siblings exist") — the read fell back to `[id]` only, so `total`/
  // `unreadCount`/`messages` reflect `id`'s own partition (+ NDJSON union, if
  // that succeeded) only. Never let this look like a complete read.
  if (meshGroupUnresolved) {
    out.meshGroupUnresolved = true;
    out.meshGroupError = meshGroupError;
    out.totalsPartial = true;
  }
  // Fix Wave 2 F3: same honesty signal `inbox count/read/ack` already emits
  // (~line 4656/4690/4814) — a forwardable sibling row sitting after a
  // non-forwardable gap was withheld from this call too (never lost, no
  // cursor touched; see foldSiblingGapRows).
  if (meshGapWithheldCount > 0) {
    out.meshGapWithheld = true;
    out.meshGapWithheldCount = meshGapWithheldCount;
  }
  // NEVER_READ_SIBLING_CAP report: same honesty posture as meshGapWithheld —
  // never silently truncate. A never-read-withheld row is not lost (its
  // partition's cursor was never advanced past it — see the cap site's own
  // comment); it becomes reachable on the caller's NEXT call to this same id
  // (pCursor is still 0 for anything withheld here, since nothing was acked
  // past it), or by reading that sibling id directly right now.
  if (meshNeverReadWithheldCount > 0) {
    out.meshNeverReadCapped = true;
    out.meshNeverReadWithheldCount = meshNeverReadWithheldCount;
    out.meshNeverReadCapLimit = NEVER_READ_SIBLING_CAP;
    // neverReadCapHint (Wave 9 (c)): name the command that reads what was held
    // back. "Call again" is only true for a partition this caller ACKS; for a
    // live peer's partition (never acked) the direct read is the ONLY way to
    // see the rest, so the hint always points at it.
    const capNames = Array.from(new Set(meshNeverReadCappedIds.map(String)));
    out.neverReadCapHint = 'withheld ' + meshNeverReadWithheldCount + ' row(s) from '
      + capNames.length + ' sibling partition(s) (cap ' + NEVER_READ_SIBLING_CAP + '); read them directly with: '
      + capNames.map((pid) => 'inbox messages ' + pid).join(' ; ');
  }
  // WINDOW report (--since/--tail): same never-silently-truncate posture as
  // every other withholding signal in this function. `windowWithheld` rows were
  // NOT delivered by this call and NOTHING was acked, so they remain readable by
  // re-running without the window flags.
  if (windowActive) {
    out.window = {
      since: windowSince ? { kind: windowSince.kind, value: windowSince.value } : null,
      tail: windowTail,
      withheld: windowWithheld,
    };
    if (windowUndated > 0) out.window.undatedKept = windowUndated;
    // A merged multi-partition read makes `index` PER-PARTITION, so an
    // index-form --since is not a single global ordinal there. Say so rather
    // than let the caller assume one sequence.
    if (windowSince && windowSince.kind === 'index' && meshAddedTotal > 0) out.window.indexIsPerPartition = true;
  }
  // UNBOUNDED-READ CAP report (defect 8d0a66cfc563): never silently truncate.
  // `count`/`messages` above already reflect only what was actually
  // delivered this call; `total`/`unreadCount` still report the REAL,
  // untruncated totals (unchanged by capping) so a caller can see the gap.
  // `truncated:true` is the explicit, un-missable signal — this call did NOT
  // return everything, `truncatedCount` more is still pending, and it is
  // safe to read again (with a higher --limit, or after acking this batch)
  // to retrieve it, because the cursor math above never advanced past a
  // withheld row.
  if (truncatedCount > 0) {
    out.truncated = true;
    out.truncatedCount = truncatedCount;
    out.limit = inboxReadLimit;
    out.truncatedHint = 'not all unread messages were returned (' + truncatedCount + ' withheld) — '
      + 'the read cursor was NOT advanced past withheld messages, so re-reading (optionally with a '
      + 'higher --limit than ' + inboxReadLimit + ') returns them';
  }
  return out;
}

function cmdInbox(sub, id, flags, ctx) {
  const home = ctx.home;
  // --since/--tail belong to the NON-ACKING `inbox messages` verb only. Every
  // other sub-verb here either acks a contiguous unread prefix (`read`, `ack`,
  // `read-primary`) or reports counts over one (`count`), and a window cannot
  // be expressed as a prefix — see INBOX_WINDOW_FLAGS' header. Reject loudly;
  // the pre-fix behaviour (silently ignoring the flag and returning the
  // EARLIEST rows while the caller believed they asked for the newest) is the
  // defect. `messages` is excluded here and handles the flags itself.
  if (sub !== 'messages') {
    const rej = inboxWindowRejection(flags, 'inbox ' + String(sub));
    if (rej) return rej;
  }
  if (sub === 'pull') return cmdInboxPull(id, flags, ctx);
  if (sub === 'messages') return cmdInboxMessages(id, flags, ctx);
  if (sub === 'read-primary') return cmdInboxMessages(id, flags, ctx, { ack: true });
  // peek-primary (spec item 5b / D): the non-mutating counterpart to
  // read-primary — same unread-only view, NEVER acks/advances the cursor.
  // Reuses the existing non-acking `messages` path internally (opts.ack
  // false), forcing the same unread-scoped filter read-primary uses (opts.
  // unread true) so a caller genuinely wanting "what would read-primary show
  // me" without consuming it has a real, tested verb instead of overloading
  // read-primary's semantics or trusting injected wording alone.
  if (sub === 'peek-primary') return cmdInboxMessages(id, flags, ctx, { ack: false, unread: true, action: 'peek-primary' });
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
    //
    // The actual union MATH now lives in companion/lib/devswarm-unread.js
    // (unionUnread) — shared with hooks + liveness.js so all three readers
    // agree on one implementation instead of drifting copies. This call site
    // keeps its OWN store-open/ownership/rehome logic (resolveWorkspaceStoreForRead)
    // unchanged — that part is CLI-specific — and only delegates the merge
    // computation, so output stays byte-identical to before this refactor.
    let storeHandle = null;
    // storeUnavailable (defect e586afdaa968): the store side being unopenable
    // is NOT the same fact as "the store side holds 0 unread", but that is
    // exactly how it read — the refusal was swallowed here and the response
    // still carried unreadStore:0 / cursorStore:0 / known:true, indistinguish-
    // able from an empty mailbox. The commonest cause is the id being
    // registered in ANOTHER project, i.e. precisely the workspace whose mail
    // this caller structurally cannot see. Delivery stays fail-open (the
    // NDJSON side is still reported, count/read never newly hard-fail), but
    // the store side is now reported as UNKNOWN, with the reason attached.
    let storeUnavailable = null;
    try {
      const opened = resolveWorkspaceStoreForRead(id, ctx, home);
      if (opened.ok) storeHandle = opened.store;
      else {
        storeUnavailable = {
          reason: opened.reason || 'store-unavailable',
          error: opened.error || null,
          registeredRepoKey: opened.registeredRepoKey || null,
          callerRepoKey: opened.callerRepoKey || null,
        };
      }
    } catch (e) {
      storeUnavailable = {
        reason: 'store-open-failed',
        error: String((e && e.message) || e),
        registeredRepoKey: null,
        callerRepoKey: null,
      };
    }
    const union = devswarmUnread.unionUnread({ inboxPath, cursorPath, id, storeHandle });
    const storeCursorVal = union.storeCursor;
    let storeOnlyUnreadRows = union.storeOnlyUnreadRows;

    // ---- MESH PARTITION WIDENING (defect 27cd80902435, remaining gap) ----
    // `count`/`read`/`ack` read `id`'s own store partition ONLY (via
    // unionUnread above) even when `id` belongs to a multi-row mesh group —
    // two registry rows sharing one meshId, the exact field case this defect
    // reports (372 real messages sat unread in a sibling partition this path
    // never opened, while `count` reported the dead partition's total as if
    // it were complete). Reuses resolveMeshPartitionIds — the SAME
    // canonicalMeshId/meshCandidateRows grouping cmdInboxMessages's
    // read-primary/peek-primary fix (v0.82.0/14c73f9) and `send --to-primary`
    // already use — no parallel implementation. STORE-side only (mirrors
    // cmdInboxMessages's own sibling widening — the NDJSON descriptor channel
    // is per-`id`, not per-mesh-group). Each sibling's own STORE cursor
    // (storeHandle.cursorValue(pid) — the SAME per-partition cursor namespace
    // `union.storeCursor` above uses for `id`) gates its own unread slice, so
    // a sibling's cursor can never be conflated with `id`'s. Fail-open: any
    // resolution/read error narrows to `id`'s own partition, identical to the
    // pre-fix single-partition read.
    let meshPartitionIds = [String(id)];
    let meshUnionActive = false;
    let meshGroupUnresolved = false;
    let meshGroupError = null;
    const meshSiblingPartitions = [];
    let meshAddedTotal = 0;
    let meshAddedUnreadCount = 0;
    if (storeHandle) {
      let wtPath = null;
      try {
        const selfRow = (storeHandle.listRegistry() || []).find((r) => r && String(r.id) === String(id));
        wtPath = (selfRow && selfRow.worktreePath) || (desc && desc.worktreePath) || null;
      } catch (_) { wtPath = (desc && desc.worktreePath) || null; }
      const resolved = resolveMeshPartitionIds(storeHandle, id, wtPath);
      meshPartitionIds = resolved.meshPartitionIds;
      meshUnionActive = resolved.meshUnionActive;
      meshGroupUnresolved = resolved.meshGroupUnresolved;
      meshGroupError = resolved.meshGroupError;
      if (meshUnionActive) {
        for (const pid of meshPartitionIds) {
          if (pid === String(id)) continue; // `id`'s own slice is already in `union`/`storeOnlyUnreadRows` above
          try {
            // P0 (v0.90.1): this used the STORE cursor alone while
            // `read-primary` used `cursors/<pid>.json` alone — the two
            // namespaces diverge (foldOne / reap-orphans advance only the
            // store side), so `count` reported 0 unread while `read-primary`
            // re-delivered the whole backlog. Both now size from MAX of the
            // two, plus this caller's live-sibling watermark when the sibling
            // is not ackable — the SAME inputs read-primary uses, so the two
            // surfaces can no longer report different amounts of outstanding
            // mail. Read-only: `count` never writes any of them.
            const pBase = siblingBaseCursor(storeHandle, home, pid);
            let pCursor = pBase;
            try {
              if (siblingAckGate(storeHandle, id, pid, home, ctx.now)) {
                pCursor = Math.max(pBase, readSiblingSeenCursor(home, id, pid));
              }
            } catch (_) { pCursor = pBase; }
            const pTotal = storeHandle.messageCount(pid);
            const pMessages = storeHandle.listMessages(pid, { sinceCursor: pCursor })
              .map((r) => Object.assign({ partitionId: pid }, r));
            meshSiblingPartitions.push({ id: pid, cursor: pCursor, total: pTotal, messages: pMessages });
            meshAddedTotal += pTotal;
          } catch (e) {
            // P1-B fix (Codex review of HEAD): pre-fix this swallowed a
            // sibling-partition READ failure (cursorValue/messageCount/
            // listMessages throwing — e.g. a corrupt journal file for THAT
            // one sibling) with no signal at all, unlike the resolution-step
            // failure a few lines above (resolved.meshGroupUnresolved) which
            // DOES surface. An unreadable sibling then read as
            // indistinguishable from "this sibling genuinely has no unread
            // mail" — `count`/`read` returned ok:true with an honest-looking
            // but silently undercounted total. Surface it the SAME way the
            // resolution-step failure already does (same field shape, one
            // convention for callers to check) — fail-open stays (this
            // sibling is skipped, delivery for every OTHER readable source
            // still succeeds), but the result must say so.
            meshGroupUnresolved = true;
            meshGroupError = 'sibling partition ' + JSON.stringify(pid) + ' unreadable: ' + String((e && e.message) || e);
          }
        }
      }
    }
    // Defensive dedup against everything already in `storeOnlyUnreadRows` by
    // `hash` — schema-guaranteed unique per partition (meshMessageHash hashes
    // the RECIPIENT too, so two DIFFERENT partitions can never share a hash by
    // construction; see cmdInboxMessages's own header comment on this point)
    // so this can never actually fire in practice. Belt-and-suspenders only,
    // mirroring that same convention — never suppresses a genuinely distinct
    // message (at-least-once beats at-most-once).
    //
    // P1-A fix (composed duplicate-delivery: fold's gapped-cursor fix x
    // send-forwarding — Codex review of HEAD): the ABOVE hash check alone
    // cannot catch a real duplicate here. foldOne (~1611-1646) forwards every
    // FORWARDABLE row for a candidate's whole unread range even PAST a
    // non-forwardable gap, but only advances that candidate's OWN cursor
    // through the CONTIGUOUS forwarded prefix before the first gap
    // (advanceTo/sawGap). A `[forwardable, non-forwardable, forwardable]`
    // sequence on a candidate the fold leaves LIVE (a real mesh sibling,
    // sharing `id`'s worktreePath/meshId — meshCandidateRows) therefore has
    // its THIRD row already forwarded into `id`'s own partition (a real copy
    // exists there) while the candidate's own cursor is stuck at 1, so that
    // SAME row also still reads as "unread" on the candidate's own
    // partition. meshMessageHash hashes the recipient, so the original
    // (to: candidate) and the forward (to: id) hash differently — the
    // existing hash-equality check structurally cannot see they are the same
    // logical message, and the union would deliver it twice.
    //
    // FIX CHOSEN AND WHY (both options in the assignment were tried; this is
    // the one that survived): a first attempt recomputed the hash a sibling
    // row WOULD carry if forwarded into `id`'s own partition (same envelope
    // foldOne's forward step uses) and suppressed a match — i.e. dedup on
    // "original message identity" via a CONTENT-derived hash. That is
    // UNSOUND: it is content-addressed with no real provenance link, so it
    // ALSO matches the exact P0 case this repo already fixed and tests
    // (devswarm-mesh-union-review-fixes.test.js) — two INDEPENDENT real
    // sends to DIFFERENT recipients that happen to share sender+ts+body+
    // urgency. Verified live: that content-hash approach collapsed the P0
    // guard test from 2 delivered messages to 1 — a genuine message-loss
    // regression, not a fix. A sound identity link would need real
    // PROVENANCE (e.g. the archived-orphan forward path's body-prefix
    // marker, forwardArchivedOrphanUnread/archivedForwardProvenancePrefix —
    // the ONE place in this codebase that already does content-hash
    // matching safely, because ITS forwarded body is prefixed and therefore
    // never coincidentally matches unrelated real content) — but foldOne's
    // own forward is contractually BODY-VERBATIM (devswarm-fold-mesh.test.js
    // asserts `forwarded.body === 'which approach?'`, an established,
    // tested contract), and adding a schema column to carry real provenance
    // is out of proportion for this fix.
    //
    // Fix instead (option (b), STRUCTURAL, no content guessing): within a
    // sibling's currently-unread window (already fetched above, in its own
    // natural order), walk it in order and track the first NON-forwardable
    // row seen. STALE as of Fix Wave 2 (F1): this used to say "a
    // non-forwardable row is NEVER excluded" — true only of the FIRST
    // non-forwardable row in the window (the gap TRIGGER, still always
    // delivered — foldOne never forwards one, so it can never have a
    // duplicate anywhere, always safe, always genuinely unread). Once that
    // trigger sets the gap, EVERY subsequent row — forwardable or not — is
    // withheld as part of the ambiguous suffix (foldSiblingGapRows, ~line
    // 1437); a SECOND non-forwardable row later in the same window is no
    // longer exempt. EVERY forwardable row AT OR AFTER that first
    // non-forwardable row is withheld from this widened view —
    // exactly the ambiguous suffix a fold's own advanceTo/sawGap logic also
    // refuses to advance the CANDIDATE's cursor past, for the identical
    // reason: a forwardable row past a gap MIGHT already be a forwarded
    // duplicate (if a fold has already run), or MIGHT be genuinely new
    // unforwarded mail (if none has run since) — this call cannot tell
    // which, structurally, without either guessing (unsound, see above) or
    // side-effecting a live re-forward from a read path (a much larger,
    // riskier change than this fix's scope). Withholding is never silent —
    // see meshGapWithheld/meshGapWithheldCount below — and NOTHING is ever
    // lost: no cursor is touched here, so a withheld row stays reachable by
    // reading that sibling id directly, and is delivered here automatically
    // once a fold actually processes it (removing the gap) or the next
    // fold's forward genuinely lands a hash-identical copy in `id`'s own
    // partition (still caught by the pre-existing exact-hash check above).
    // Sound against the P0 case: a partition with NO non-forwardable row in
    // its unread window has no "gap" at all, so nothing is withheld — the P0
    // test's two single-row sends each sit in a gap-free window and both
    // pass through unaffected (re-asserted as a guard test).
    // Fix Wave 2 F1 (P0 message-loss): delegated to foldSiblingGapRows (see
    // its own header comment, ~line 1408) — the fold now produces a genuine
    // index-based PREFIX per partition, so `part.deliveredCount` is always
    // safe to add to `part.cursor` for the ack target below. deliveredRows
    // (P2-D cap support) stays its OWN array per part, not flattened into
    // one global list, so the cap step below can slice each source's
    // contribution independently and preserve the "never withhold row N-1
    // while keeping row N of the same source" invariant — see that step's
    // own comment.
    let meshGapWithheldCount = 0;
    if (meshSiblingPartitions.length) {
      // defect 64861a623503 — same consumed-history seeding as cmdInboxMessages'
      // sibling fold (see consumedDedupSeed); the two surfaces must not diverge.
      const seed = consumedDedupSeed(storeHandle, id, storeCursorVal, CONSUMED_HASH_SEED_CAP);
      const seenHashes = seed.hashes;
      // R13 item 11: the ORIGINAL's identity too — same reason and same
      // primitive as cmdInboxMessages' own seeding loop (see its comment). The
      // two surfaces must not diverge.
      for (const r of storeOnlyUnreadRows) {
        if (!r) continue;
        if (r.hash) seenHashes.add(r.hash);
        const oh = forwardedOrigHashOf(r);
        if (oh) seenHashes.add(oh);
      }
      const seenLogical = seed.logical;
      for (const part of meshSiblingPartitions) {
        const folded = foldSiblingGapRows(part.messages, seenHashes, seenLogical);
        part.deliveredRows = folded.deliveredRows;
        part.deliveredCount = folded.deliveredCount;
        // G1/G2 fix: see foldSiblingGapRows's own header comment (~line
        // 1437) and the cmdInboxMessages call site's analogous field
        // (~line 4126) — the ack step below (post-cap) derives the PHYSICAL
        // ack target from this, never from `deliveredCount` alone.
        part.consumedThrough = folded.consumedThrough;
        part.consumedCount = folded.consumedCount;
        meshGapWithheldCount += folded.gapWithheldCount;
      }
    }
    // P2-D fix (Codex review of HEAD): read-primary/peek-primary/--ack
    // already cap via DEFAULT_INBOX_READ_LIMIT/--limit (cmdInboxMessages,
    // ~line 3737) — `count`/`read`/`ack` never did, and the mesh-partition
    // widening above makes an unbounded sibling backlog newly reachable
    // here too. Apply the SAME cap mechanism (same constant, same --limit
    // override rule: a non-finite/non-positive override is ignored, never
    // silently disables the cap) rather than inventing a second one.
    // Unlike cmdInboxMessages, this array is never ts-sort-merged across
    // sources — it is a plain concatenation (id's own rows, in their own
    // natural listMessages order, then each sibling's already-deduped rows,
    // each still in ITS OWN natural order) — so a straight per-source
    // length slice already IS a genuine structural prefix; no source-index
    // withholding/recovery machinery is needed to keep cmdInboxMessages's
    // own cap invariant. `part.deliveredCount` is overwritten here to the
    // POST-cap kept length so the ack step below (which reads it to derive
    // each sibling's cursor-ack target) never advances a sibling's cursor
    // past a row this call withheld.
    let inboxCapLimit = DEFAULT_INBOX_READ_LIMIT;
    {
      const limitRaw = one(flags, 'limit');
      if (limitRaw !== undefined) {
        const n = Number(limitRaw);
        if (Number.isFinite(n) && n > 0) inboxCapLimit = Math.max(1, Math.floor(n)); // F4: same fix, same reasoning as inboxReadLimit above
      }
    }
    const ownRows = storeOnlyUnreadRows; // id's own rows, pre-sibling-merge
    const ownRowsTotal = ownRows.length;
    const preCapTotal = ownRowsTotal + meshSiblingPartitions.reduce((n, p) => n + (p.deliveredRows ? p.deliveredRows.length : 0), 0);
    let inboxTruncatedCount = 0;
    let ownKeptCount;
    if (preCapTotal > inboxCapLimit) {
      inboxTruncatedCount = preCapTotal - inboxCapLimit;
      let remaining = inboxCapLimit;
      ownKeptCount = Math.min(ownRowsTotal, remaining);
      remaining -= ownKeptCount;
      storeOnlyUnreadRows = ownRows.slice(0, ownKeptCount);
      for (const part of meshSiblingPartitions) {
        const rows = part.deliveredRows || [];
        const keep = Math.min(rows.length, remaining);
        remaining -= keep;
        part.deliveredCount = keep; // overwrite: post-cap kept count, what the ack step below may advance past
        // G1/G2 fix: the PHYSICAL row count to advance past for these `keep`
        // delivered rows — see foldSiblingGapRows's header comment
        // (~line 1437) and the cmdInboxMessages call site (~line 4282). When
        // `keep` covers the partition's ENTIRE deliveredRows (nothing
        // actually capped here), use the fold's own full `consumedCount` —
        // it also covers a TRAILING consumed-but-undelivered row (e.g. a
        // dedup after the last delivered row) that `consumedThrough` cannot
        // see. Otherwise use `consumedThrough[keep - 1]`.
        // NOTE: the "nothing capped for this partition" check MUST run
        // BEFORE the `keep <= 0` short-circuit — G1's exact wedge case has
        // `keep === 0 === rows.length` (nothing delivered AND nothing
        // capped, e.g. a `[hole]`-only window), and that case still needs
        // `part.consumedCount` (1, the hole itself), not a hard 0.
        const consumedThrough = Array.isArray(part.consumedThrough) ? part.consumedThrough : null;
        part.physicalConsumed = (keep >= rows.length && Number.isFinite(part.consumedCount))
          ? part.consumedCount
          : (keep <= 0
            ? 0
            : (consumedThrough && Number.isFinite(consumedThrough[keep - 1]) ? consumedThrough[keep - 1] : keep));
        if (keep) storeOnlyUnreadRows = storeOnlyUnreadRows.concat(rows.slice(0, keep));
      }
    } else {
      ownKeptCount = ownRowsTotal;
      for (const part of meshSiblingPartitions) {
        if (part.deliveredRows && part.deliveredRows.length) storeOnlyUnreadRows = storeOnlyUnreadRows.concat(part.deliveredRows);
        // G1/G2 fix: nothing capped for this partition — the physical
        // ack target is the fold's own full consumed count (may exceed
        // `deliveredCount` when a corrupted/deduped row was resolved
        // without being delivered).
        part.physicalConsumed = Number.isFinite(part.consumedCount) ? part.consumedCount : (part.deliveredCount || 0);
      }
    }
    // Fix Wave 2 F2 (undercount + missing honesty flag): `meshAddedUnreadCount`
    // must be the REAL, UNTRUNCATED sibling count — not the post-cap kept
    // count (`storeOnlyUnreadRows.length - ownKeptCount`, which is <= the
    // real total whenever `inboxTruncatedCount > 0`). Matches
    // cmdInboxMessages, which sets its own `meshAddedUnreadCount` from
    // `dedupedSiblingRows.length` BEFORE its cap step ever runs (~line 4007).
    // `part.deliveredRows` (the gap-fold output) is untouched by the cap step
    // above — only `part.deliveredCount`/`storeOnlyUnreadRows` are
    // overwritten/sliced — so summing `.deliveredRows.length` here is exactly
    // the pre-cap, real total (equal to `preCapTotal - ownRowsTotal`).
    meshAddedUnreadCount = meshSiblingPartitions.reduce((n, p) => n + (p.deliveredRows ? p.deliveredRows.length : 0), 0);

    // FIX 6 (TRACED): the two parallel, independently-cursored channels — the
    // NDJSON descriptor inbox and the store partition — were surfaced as a bare
    // `unread` (actually the SUM of both) sitting beside `storeUnread` (one of
    // the two components), with NO field naming the NDJSON component at all.
    // That mislabeling made a real NDJSON backlog invisible to an operator
    // reading only the store side. Emit all three explicitly: unreadTotal (the
    // sum, same value `unread` always was), unreadNdjson, unreadStore (same
    // value `storeUnread` always was), plus cursorNdjson/cursorStore. `unread`/
    // `storeCursor`/`storeUnread` are kept as EXACT ALIASES for compatibility —
    // never the primary name going forward.
    const unreadNdjsonCount = union.ndjsonUnreadLines.length;
    // unreadStoreCount/outTotal fold in meshAddedUnreadCount/meshAddedTotal
    // (the mesh-partition widening above) — 0/no-op whenever meshUnionActive
    // is false, so a single-row workspace's output is byte-identical to
    // pre-fix. `union.unread`/`union.total` are captured BEFORE the widening
    // ran, so the additive terms are added back explicitly here rather than
    // re-reading (now-stale) fields off `union`.
    const unreadStoreCount = storeOnlyUnreadRows.length;
    const outUnreadTotal = union.unread + meshAddedUnreadCount;
    const outTotal = union.total + meshAddedTotal;
    if (sub === 'count') {
      if (storeHandle) storeHandle.close();
      return {
        ok: true, action: 'count', id,
        unreadTotal: outUnreadTotal, unreadNdjson: unreadNdjsonCount, unreadStore: unreadStoreCount,
        cursorNdjson: union.cursor, cursorStore: storeCursorVal,
        total: outTotal, known: union.known && !storeUnavailable,
        ...(storeUnavailable ? { storeUnavailable, unreadStoreUnknown: true } : {}),
        ...(meshGroupUnresolved ? { meshGroupUnresolved: true, meshGroupError, totalsPartial: true } : {}),
        // Fix Wave 2 F2: `count` used to omit `meshGapWithheld`/
        // `meshGapWithheldCount` entirely (they went only to `read`/`ack`
        // below), so a caller relying on `count` alone had no honesty signal
        // that some sibling mail was withheld pending a gap resolving. Same
        // fields, same meaning, as `read`/`ack` emit.
        ...(meshGapWithheldCount > 0 ? { meshGapWithheld: true, meshGapWithheldCount } : {}),
        // P2-D cap report — same shape/fields as cmdInboxMessages's own
        // (defect 8d0a66cfc563): `total`/`unreadTotal` above NOW genuinely
        // reflect the REAL, untruncated totals (Fix Wave 2 F2 — previously
        // `meshAddedUnreadCount` was computed POST-cap here, so this claim
        // was false whenever `inboxTruncatedCount > 0`); `unreadStore`
        // reflects only what this call actually returned. `truncated:true`
        // is the explicit signal this call did not return everything.
        ...(inboxTruncatedCount > 0 ? {
          truncated: true, truncatedCount: inboxTruncatedCount, limit: inboxCapLimit,
          truncatedHint: 'not all unread messages were returned (' + inboxTruncatedCount + ' withheld) — '
            + 'the read cursor was NOT advanced past withheld messages, so re-reading (optionally with a '
            + 'higher --limit than ' + inboxCapLimit + ') returns them',
        } : {}),
        // compat aliases (see comment above) — do not treat as primary:
        unread: outUnreadTotal, cursor: union.cursor, storeCursor: storeCursorVal, storeUnread: unreadStoreCount,
      };
    }
    if (sub === 'read') {
      if (storeHandle) storeHandle.close();
      return {
        ok: true, action: 'read', id,
        lines: union.ndjsonUnreadLines, meshMessages: storeOnlyUnreadRows,
        unreadTotal: outUnreadTotal, unreadNdjson: unreadNdjsonCount, unreadStore: unreadStoreCount,
        cursorNdjson: union.cursor, cursorStore: storeCursorVal,
        total: outTotal, known: union.known && !storeUnavailable,
        ...(storeUnavailable ? { storeUnavailable, unreadStoreUnknown: true } : {}),
        ...(meshGroupUnresolved ? { meshGroupUnresolved: true, meshGroupError, totalsPartial: true } : {}),
        // P1-A honesty report: a forwardable row sitting AFTER a
        // non-forwardable gap in a sibling's unread window was withheld
        // from this call (see the fix's own comment above) — never lost
        // (no cursor touched), but not shown here either. `meshGapWithheld`
        // is the explicit signal; read that sibling id directly, or wait
        // for its next fold pass, to see it.
        ...(meshGapWithheldCount > 0 ? { meshGapWithheld: true, meshGapWithheldCount } : {}),
        ...(inboxTruncatedCount > 0 ? {
          truncated: true, truncatedCount: inboxTruncatedCount, limit: inboxCapLimit,
          truncatedHint: 'not all unread messages were returned (' + inboxTruncatedCount + ' withheld) — '
            + 'the read cursor was NOT advanced past withheld messages, so re-reading (optionally with a '
            + 'higher --limit than ' + inboxCapLimit + ') returns them',
        } : {}),
        // NON-ADVANCE HONESTY (defect 56ba248504d0, item 7). `read` is the
        // READ-ONLY half of this verb family — it deliberately advances NO
        // cursor (that is `ack`'s job, and it is what lets `read` stay safe to
        // run from ANY project; see the ack path's own project-mismatch refusal
        // below, which tells callers exactly that). But the output never SAID
        // so, and that silence is what the field report is actually made of: an
        // operator ran `inbox read <twinId>` ten times, watched `unreadNdjson`
        // sit at 401 every time, and reasonably concluded the rows were
        // unreachable. They were not — `inbox ack <twinId>` drains them (proven
        // by test) — but nothing on this surface pointed at that command.
        //
        // So state it, on the one surface the operator is already looking at,
        // and name the EXACT command. Present only when there is genuinely
        // something outstanding, so a fully-drained read's shape is unchanged.
        ...(outUnreadTotal > 0 ? {
          cursorAdvanced: false,
          ackHint: '`inbox read` is READ-ONLY and advanced no cursor — these '
            + outUnreadTotal + ' unread row(s) (' + unreadNdjsonCount + ' durable-NDJSON, '
            + unreadStoreCount + ' store) stay unread until `devswarm.js inbox ack ' + id
            + '` consumes them. NOTE: a Primary\'s own `inbox read-primary` folds ONLY its OWN '
            + 'descriptor\'s NDJSON channel, so another row\'s (e.g. a same-worktree twin\'s) '
            + 'durable inbox is only ever drained by acking THAT id explicitly.',
        } : {}),
        // compat aliases (see comment above) — do not treat as primary:
        count: outUnreadTotal, cursor: union.cursor, storeCursor: storeCursorVal,
      };
    }
    // sub === 'ack'
    // ---- ID-DERIVED AUTHORITY GATE (defect e586afdaa968, P0) ----
    // `count`/`read` above are non-mutating and stay FAIL-OPEN on a refused
    // store side (the NDJSON channel is id-derived and partition-independent,
    // so its mail is genuinely readable from anywhere — that readability is
    // what devswarm-parent-gate.js's remediation now depends on). `ack` is
    // NOT: it advances this descriptor's NDJSON cursor, permanently marking
    // another project's workspace's mail consumed so its real owner never
    // sees it. The advance below used to run unconditionally, so a caller the
    // store resolver had ALREADY refused still got ok:true and a moved cursor.
    // Refuse before touching either cursor.
    // Narrow on purpose: ONLY a positive cross-project mismatch refuses. Any
    // other store-open failure keeps the pre-existing fail-open ack (the store
    // side was never required for the NDJSON ack to be correct).
    if (storeUnavailable && storeUnavailable.reason === 'project-context-mismatch') {
      if (storeHandle) storeHandle.close();
      return Object.assign(
        { action: 'ack', acked: 0, cursor: null },
        projectContextMismatch(id, storeUnavailable.registeredRepoKey, storeUnavailable.callerRepoKey,
          'run this from within that project\'s worktree to ack it (`inbox read ' + id + '` is read-only and works from anywhere)'));
    }
    if (!cursorPath) { if (storeHandle) storeHandle.close(); return { ok: false, error: 'no cursorPath for workspace ' + JSON.stringify(id) }; }
    const toRaw = one(flags, 'to');
    let cursor;
    // P1a fix (defect c35a7ca3056b): populated only if the store-side cursor
    // sync below throws — see the catch site for the full rationale.
    const ackCursorWriteFailures = [];
    // Fix Wave 7 Item 1 (P0): this verb's OWN sibling cursor-write loop
    // (below) used to have NO liveness gate at all — a plain `inbox ack`
    // (or `--ack-as-owner`) from a shared canonical worktree drove a live
    // sibling's cursor forward and consumed its unread backlog undelivered,
    // reproduced with BOTH heartbeats fresh. Tracked the same shape as
    // cmdInboxMessages's `liveSiblingsSkipped` (~line 3932) for parity.
    const liveSiblingsSkipped = [];
    if (toRaw !== undefined) {
      const n = Number(toRaw);
      if (!Number.isFinite(n)) { if (storeHandle) storeHandle.close(); return { ok: false, error: '--to must be a number' }; }
      // `--to N` stays NDJSON-SCOPED, byte-for-byte unchanged from the pre-fix
      // contract: an absolute NDJSON line-count has no cross-channel meaning for
      // the store's own cursor, so ack-all (below) is the only path that also
      // clears the store side.
      cursor = inboxCursor.ackTo(cursorPath, n, undefined, inboxPath);
    } else {
      // Fix Wave 5 Item 2 (P0 message-loss): `advanceCursor()` used to RECOUNT
      // the LIVE inbox file tail at ack time (`countMessages(inboxPath)`
      // inside advanceCursor) rather than acking over the tail snapshot this
      // call actually read/delivered (`union`, captured above via
      // unionUnread — the SAME initial-read snapshot `read-primary` already
      // honors via its own `physicalConsumed`/`ownDeliveredMaxIndex` math).
      // Race: cursor=5, rows 1-6 exist, this call reads/delivers row 6, a
      // concurrent sender appends row 7 between the read and this ack —
      // `advanceCursor` recounts 7 live and writes cursor=7, permanently
      // consuming row 7 though it was never returned to this caller. Fix:
      // ack only `union.cursor + union.ndjsonUnreadLines.length` — the exact
      // contiguous prefix snapshotted at the read above — never the live
      // file's current tail. `ackTo`'s own upper clamp (via `inboxPath`)
      // still protects against a corrupt/negative target; its monotonic
      // guard still protects against under-acking a previously-further-along
      // cursor.
      cursor = inboxCursor.ackTo(cursorPath, union.cursor + union.ndjsonUnreadLines.length, undefined, inboxPath); // ack-all (ndjson side) — over THIS call's read snapshot only
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
            const ownEntry = resolveMeshTarget(storeHandle, caller, home);
            owns = caller === id || (ownEntry && ownEntry.id === id);
          }
          if (owns) {
            // Fix Wave 7 Item 3 (P0 message-loss): `storeHandle.messageCount(id)`
            // used to RECOUNT the LIVE store table at ack time — the same
            // message-loss shape Fix Wave 5 Item 2 already fixed on the NDJSON
            // side (`inboxCursor.ackTo(cursorPath, union.cursor +
            // union.ndjsonUnreadLines.length, ...)` above, over the READ
            // snapshot, never a live recount), left unfixed here on the store
            // side. Race: a concurrent sender appends a NEW row to `id`'s own
            // store partition between the `union`/`storeOnlyUnreadRows`
            // snapshot (captured above, ~line 4576) and this ack — the live
            // recount includes that row (never returned to this caller) and
            // sets the cursor past it, permanently losing it.
            // Fix: derive the ack target from the ACTUAL delivered rows' own
            // `.index` (a real, database-backed absolute 1-based position —
            // devswarm-store.js listMessages), the SAME primitive
            // cmdInboxMessages's own-store ack already uses
            // (`ownDeliveredMaxIndex`, ~line 4210) — never arithmetic over a
            // possibly-gapped row count (storeOnlyUnreadRows can have gaps
            // relative to the raw sequence: it is filtered by hash against the
            // NDJSON channel, same root cause as that fix's own header note).
            // `ownRows`/`ownKeptCount` (captured above, ~line 4772/4782) are
            // the pre-sibling-merge id-only rows and the post-cap count of
            // them actually delivered THIS call — re-sliced here rather than
            // re-derived, so this can never drift from what was truly
            // returned. Never regresses below the pre-read snapshot
            // (`storeCursorVal`), matching every other ack-target invariant
            // in this file.
            const ownDeliveredRows = ownRows.slice(0, ownKeptCount);
            let ownMaxIndex = null;
            for (const row of ownDeliveredRows) {
              if (row && Number.isFinite(row.index) && (ownMaxIndex === null || row.index > ownMaxIndex)) ownMaxIndex = row.index;
            }
            const totalNow = ownMaxIndex !== null ? Math.max(storeCursorVal, ownMaxIndex) : storeCursorVal;
            storeHandle.setCursor(id, totalNow);
            // Keep the SEPARATE `inbox messages --ack`/`read-primary` ACK-cursor
            // FILE (primaryCursorPath, a DIFFERENT namespace than this
            // descriptor's own cursorPath) in lockstep too, so a workspace that
            // mixes `inbox ack` with `read-primary` never sees those two
            // read-verbs disagree about what is already consumed.
            inboxCursor.ackTo(primaryCursorPath(home, id), totalNow);
            // Mesh sibling ack (defect 27cd80902435): advance EACH sibling
            // partition's OWN store cursor too — "per-partition cursors stay
            // per-partition" (same invariant cmdInboxMessages's read-primary
            // ack already enforces). Target is `part.cursor + deliveredCount`
            // (never `part.total` directly) — deliveredCount is the actual
            // number of that partition's rows folded into `storeOnlyUnreadRows`
            // above, so this structurally cannot advance past a row the
            // defensive dedup guard withheld. Gated by the SAME `owns` check
            // as `id`'s own ack (a caller that doesn't own `id` doesn't own
            // its siblings either).
            for (const part of meshSiblingPartitions) {
              // LIVE-SIBLING GATE (Fix Wave 7 Item 1): the SAME gate
              // cmdInboxMessages's read-primary/peek-primary ack loop applies
              // (~line 4308), via the SAME shared `siblingAckGate` — this loop
              // used to have none at all, which is exactly what let a live
              // sibling sharing this worktree get its cursor driven forward
              // and its backlog consumed undelivered by a plain `inbox ack`.
              if (siblingAckGate(storeHandle, id, part.id, home, ctx.now)) { liveSiblingsSkipped.push(part.id); continue; }
              // Fix Wave 3 G1/G2 (P0/P1): `part.physicalConsumed` (set
              // above alongside `part.deliveredCount` — see the cap-step
              // comment ~line 4682) is the PHYSICAL row count to advance
              // past, which can exceed `deliveredCount` when a corrupted/
              // null row or exact-hash duplicate was consumed without being
              // delivered. Falls back to `deliveredCount` when unset
              // (fail-open — never worse than the pre-fix behavior).
              const deliveredCount = Number.isFinite(part.deliveredCount) ? part.deliveredCount : part.messages.length;
              const physicalConsumed = Number.isFinite(part.physicalConsumed) ? part.physicalConsumed : deliveredCount;
              const ackTarget = part.cursor + physicalConsumed;
              try {
                storeHandle.setCursor(part.id, ackTarget);
                inboxCursor.ackTo(primaryCursorPath(home, part.id), ackTarget);
              } catch (e2) {
                ackCursorWriteFailures.push({ partitionId: part.id, channel: 'sibling-store-cursor', error: String((e2 && e2.message) || e2) });
              }
            }
            store.deriveSummary(storeHandle, { home, env: ctx.env, now: ctx.now });
          }
        } catch (e) {
          // defect c35a7ca3056b: this catch used to swallow the failure
          // silently and return a bare `ok:true` — the store-side cursor (and
          // its primaryCursorPath twin) could then fail to persist while the
          // NDJSON ack above already durably succeeded, so the caller had no
          // signal and those messages resurfaced as unread next read. Fail
          // OPEN on delivery (unchanged — the ndjson ack above already
          // succeeded regardless; re-serving them is the safe direction) but
          // report the persistence failure using the SAME field shape
          // cmdInboxMessages already reports (cursorWriteFailures[]/
          // cursorPersisted:false, ~line 3810 above) so consumers see one
          // convention, not two.
          try { ackCursorWriteFailures.push({ partitionId: id, channel: 'store-cursor', error: String((e && e.message) || e) }); }
          catch (_) { ackCursorWriteFailures.push({ partitionId: id, channel: 'store-cursor', error: 'unknown error' }); }
        }
      }
    }
    if (storeHandle) storeHandle.close();
    const ackOut = { ok: true, action: 'ack', id, cursor, total: inboxCursor.countMessages(inboxPath) };
    if (ackCursorWriteFailures.length) {
      ackOut.cursorWriteFailures = ackCursorWriteFailures;
      ackOut.cursorPersisted = false;
    }
    if (liveSiblingsSkipped.length) ackOut.liveSiblingsSkipped = liveSiblingsSkipped;
    if (meshGroupUnresolved) { ackOut.meshGroupUnresolved = true; ackOut.meshGroupError = meshGroupError; ackOut.totalsPartial = true; }
    if (meshGapWithheldCount > 0) { ackOut.meshGapWithheld = true; ackOut.meshGapWithheldCount = meshGapWithheldCount; }
    if (inboxTruncatedCount > 0) {
      ackOut.truncated = true;
      ackOut.truncatedCount = inboxTruncatedCount;
      ackOut.limit = inboxCapLimit;
      ackOut.truncatedHint = 'not all unread messages were acked this call (' + inboxTruncatedCount + ' withheld) — '
        + 'sibling cursors were NOT advanced past withheld messages, so acking again (optionally with a '
        + 'higher --limit than ' + inboxCapLimit + ') consumes them';
    }
    return ackOut;
  }
  return { ok: false, error: 'unknown inbox subcommand: ' + JSON.stringify(sub) + ' (read|ack|count|pull|messages|read-primary|peek-primary)' };
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
  // Task #10 (session_id realness): prefer the REAL Claude Code session id when the
  // caller didn't pass --session explicitly. CLAUDE_CODE_SESSION_ID is a genuine
  // env var Claude Code sets on every process it spawns (verified present on a live
  // session; see docs/KB-claude-codex.md's cmux discussion, which already treats it
  // as authoritative) — it is what liveness.js's transcriptMtime(projectDir,
  // sessionId) needs to find <projectDir>/<sessionId>.jsonl on disk. This call
  // ALWAYS registers the CALLER's OWN row (id is derived from the caller's own cwd
  // above, never an arbitrary target), so stamping the invoking process's own
  // session id here can never misattribute someone else's session. Previously this
  // fell back to DEVSWARM_BUILDER_ID (empty for a Primary — that env var is a
  // CHILD's identity) or the workspace `id` itself (never a real Claude session,
  // so the transcript term in readActivityTs/isDormantRow could never resolve for
  // any Primary row). DEVSWARM_BUILDER_ID is kept as the next fallback for back-
  // compat with any caller that still relies on it; `id` remains the final resort
  // so `register requires --session` never fires for a bare CLI invocation.
  const session = one(flags, 'session')
    || (ctx.env && ctx.env.CLAUDE_CODE_SESSION_ID)
    || (ctx.env && ctx.env.DEVSWARM_BUILDER_ID)
    || id;
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
  // ---- ID-DERIVED AUTHORITY GATE (defect e586afdaa968, P0) ----
  // The refusal runs BEFORE the re-home, and resolves the id's project from
  // descriptorRegisteredRepoKey (fresh worktree key, else the PERSISTED
  // repoKey/ownerKey) rather than descriptorFreshRepoKey alone. Both halves
  // were load-bearing and both were wrong here:
  //   1. ORDER — maybeRehomeToCwdProject re-homes to `repoKeyForCwd(ctx)`.
  //      Running it first meant `gate <foreign-id>` from project A physically
  //      moved a hash-stranded project-B workspace's registry row into A and
  //      rewrote its descriptor ownerKey to A's key, and THEN returned
  //      ok:false. A command that refuses must not have already moved another
  //      project's data. (Reproduced live; see
  //      tests/scripts/devswarm-cross-repo-partition.test.js.)
  //   2. AUTHORITY — descriptorFreshRepoKey returns null the moment the
  //      descriptor's worktreePath stops resolving, silently disengaging the
  //      guard and making the caller's cwd the de-facto authority for a
  //      FOREIGN workspace.
  // (maybeRehomeToCwdProject now carries its own equivalent guard too, so the
  // data movement is closed at the source for every caller; this refusal is
  // the caller-visible half.)
  const callerRepoKeyForGate = repoKeyForCwd(ctx);
  const descForGate = readDescriptorFile(home, id);
  const registeredRepoKeyForGate = descForGate ? descriptorRegisteredRepoKey(descForGate, id) : null;
  if (registeredRepoKeyForGate && registeredRepoKeyForGate !== callerRepoKeyForGate) {
    return projectContextMismatch(id, registeredRepoKeyForGate, callerRepoKeyForGate,
      'run this from within that project\'s worktree to gate it');
  }
  // GH1: re-home a hash-bucket-stranded workspace into store/<repoKey>/ BEFORE
  // opening the store — otherwise the gate lands in / reads from the wrong store,
  // the workspace shows tracked:false, and the gate silently no-ops. Best-effort
  // + under the per-id lock (held internally); a no-op when not stranded.
  try { maybeRehomeToCwdProject(home, id, ctx); } catch (_) { /* fail-open: gate proceeds */ }
  // v0.57 mesh (D24): gates land in the SAME shared per-project store the
  // registry/roster/archive_ready read (repoKey, when resolvable).
  const s = store.openStore({ home, workspaceId: id, hash: callerRepoKeyForGate || undefined, backend: ctx.backend, env: ctx.env });
  let summary;
  try {
    for (const name of setNames) s.setGate({ workspaceId: id, name, value: true, setBy });
    for (const name of clearNames) s.setGate({ workspaceId: id, name, value: false, setBy });

    // MERGED-GATE GROUND-TRUTH VERIFICATION (report-only, mechanical — never
    // blocks). When a child sets `merged`, best-effort verify HEAD is an
    // ancestor of the resolved default branch. The gate is set REGARDLESS of
    // the verdict either way — a squash/rebase merge legitimately breaks
    // ancestry even though the work IS merged, so a false/null verdict must
    // never block archive_ready; `merged_verified` is persisted ALONGSIDE
    // `merged` purely so the parent can see whether the claim was proven or
    // is self-declared. See devswarm-git-truth.js for the field incident
    // (unpushed/unmerged work self-declared done) this exists to catch.
    if (setNames.includes('merged')) {
      // Reuse descForGate (already read above for the project-context-mismatch
      // guard) rather than a second descriptor read for the same id.
      const worktreePath = descForGate && descForGate.worktreePath ? descForGate.worktreePath : null;
      if (worktreePath) {
        let verified = null;
        try { verified = gitTruth.gitMergedInto(worktreePath); } catch (_) { verified = null; }
        if (verified === true) {
          s.setGate({ workspaceId: id, name: 'merged_verified', value: true, setBy });
        } else if (verified === false) {
          s.setGate({ workspaceId: id, name: 'merged_verified', value: false, setBy });
          try {
            process.stderr.write('[devswarm] gate: `merged` set, but HEAD does not appear to be an ancestor of '
              + 'the default branch (git ground-truth check) — this can be normal for a squash/rebase merge; the '
              + 'gate is still set (report-only, never blocked). See the parent roster for the "(unverified)" mark.\n');
          } catch (_) {}
        }
        // verified === null (unresolvable default branch / spawn failure) -> omit entirely, never fabricate.
      }
    }

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
// retireIdentityFamilyDescriptors(home, archivedId, desc) — the DESCRIPTOR-FILE
// half of "archive retires the whole identity family".
//
// ROOT CAUSE this closes (live incident): cmdArchive keys its tombstone as
// `archived/<id>.json` and retires exactly ONE descriptor file. When the SAME
// workspace is registered under TWO descriptor ids — the builder-id UUID row and
// the slug row named in companion/lib/devswarm-identity-family.js's header —
// archiving one of them could never retire the other. The survivor stayed in
// `workspaces/`, `readDescriptors` (companion/devswarm-supervisor.js) kept
// enumerating it (it cross-checks no tombstone), and hooks/devswarm-parent-gate.js
// kept nagging the Primary about a workspace the user had already archived.
//
// SCOPE — DESCRIPTORS ONLY, deliberately. The REGISTRY half already has an owner:
// retireArchivedWorktreeGroup (above), which folds same-worktree registry rows in
// THIS project's store. A twin can legitimately carry a DIFFERENT repoKey (the
// live incident's pair did: `skycrew-a7a7a5` vs `modules-ba76c8`, a nested module
// worktree), and cmdArchive's own ID-DERIVED AUTHORITY GATE exists precisely to
// refuse cross-project store mutation. So this pass never touches another
// project's store — it retires the descriptor FILE, which is the artifact the
// gate/supervisor actually read, and SURFACES every twin it did not retire.
//
// GROUPING RULE: NOT re-derived here. `identityFamilyTwins`
// (companion/lib/devswarm-identity-family.js) owns it — the same module that owns
// the read-time collapse — so there is exactly ONE identity-grouping rule in the
// tree. It uses the STRONGEST link only (one row's sessionId IS the other row's
// id), never bare worktree equality, so two legitimately-live tabs on one
// worktree are never retired. See that module for the full argument.
//
// NEVER DELETES: a twin's bytes are hardlinked into `archived/` and only THEN is
// the active path unlinked, and the unlink runs ONLY after a fresh lstat of BOTH
// paths proves they are the same inode. If the archived path already holds
// DIFFERENT bytes, nothing is unlinked — the twin is left live and surfaced.
// IDEMPOTENT: a re-run finds no active twin descriptor and does nothing.
// FAIL-OPEN: never throws; a failure here must never break archive itself.
// LOCKING: each twin is taken under its OWN withIdLock. `archivedId` is never
// locked here (cmdArchive already holds it, and the lock is not re-entrant) —
// every twin is != archivedId by identityFamilyTwins' own guard. A lock-busy
// twin is SKIPPED and surfaced, never blocked on.
// `opts.dryRun` classifies WITHOUT writing (doctor's detect()): twins that WOULD
// be retired land in `retired`, nothing is linked, unlinked, or locked.
// `opts.requireWorktreeGone` (P0-3): demand POSITIVE liveness evidence before
// retiring. Used by the MIGRATION path only — see foldArchivedFamilyDescriptors.
function retireIdentityFamilyDescriptors(home, archivedId, desc, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const requireWorktreeGone = !!(opts && opts.requireWorktreeGone);
  const out = { retired: [], left: [] };
  try {
    if (!desc || archivedId == null) return out;
    const idFam = require('../companion/lib/devswarm-identity-family.js');
    const archiveDirState = checkedArchivedDir(home, { create: true });
    if (!archiveDirState.ok) return out;
    let names = [];
    try { names = fs.readdirSync(workspacesDir(home)); } catch (_) { return out; }
    const candidates = [];
    // SCAN-TIME GENERATION, per candidate id. The classification below is made
    // against THESE bytes/inode; the write below re-proves them INSIDE the lock.
    const scanFp = new Map();
    for (const n of names) {
      if (!/\.json$/.test(n)) continue;
      const cid = n.slice(0, -5);
      if (String(cid) === String(archivedId)) continue;
      if (!isSafeId(cid)) continue;
      let fp;
      try { fp = descriptorFileGeneration(path.join(workspacesDir(home), n)); } catch (_) { continue; }
      if (!fp || !fp.descriptor) continue;
      const d = fp.descriptor;
      // The filename IS the id of record; a descriptor whose body disagrees is
      // malformed and must never be acted on (same identity check cmdArchive
      // applies to its own target).
      if (!isSafeId(d.id) || String(d.id) !== String(cid)) continue;
      candidates.push(d);
      scanFp.set(String(d.id), fp);
    }
    for (const twin of idFam.identityFamilyTwins(desc, candidates)) {
      const tid = String(twin.id);
      // P0-3 SAFETY REFUSAL (migration path only). A one-way historical link read
      // out of a STALE tombstone is NOT write authority: descriptor ids get
      // reused, so `archived/A.json`.sessionId === 'B' may name a B that is today
      // an unrelated, genuinely LIVE workspace. Retire only with positive
      // evidence that this twin is not live — its worktree provably absent.
      // Anything we cannot prove leaves it ACTIVE and SURFACED.
      if (requireWorktreeGone && !worktreeIsProvablyGone(twin.worktreePath)) {
        out.left.push({ id: tid, reason: 'live-or-unprovable-worktree' });
        continue;
      }
      if (dryRun) { out.retired.push(tid); continue; }
      const activePath = descriptorPath(home, tid);
      const archivedPath = path.join(archiveDirState.path, tid + '.json');
      const before = scanFp.get(tid);
      const r = withIdLock(tid, home, () => {
        try {
          // P0-1 RE-PROVE INSIDE THE LOCK. Between the scan above and this lock a
          // concurrent `register`/`ensure`/child-turn may have atomically replaced
          // this pathname with a NEW, LIVE descriptor (rename => new inode). The
          // classification was made against `before`; if what is on disk NOW is a
          // different generation, our authority to retire it does not exist.
          // SAFETY REFUSAL: leave it active, surface it, let a later run decide.
          const now = descriptorFileGeneration(activePath);
          if (!now) return { ok: false, reason: 'descriptor-unreadable-at-retire' };
          if (!sameDescriptorGeneration(before, now)) {
            return { ok: false, reason: 'descriptor-changed-since-scan' };
          }
          try { fs.linkSync(activePath, archivedPath); }
          catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
          const a = fs.lstatSync(activePath);
          const b = fs.lstatSync(archivedPath);
          if (a.dev !== b.dev || a.ino !== b.ino) {
            // A pre-existing tombstone holding DIFFERENT bytes — or the SAME bytes
            // at a DIFFERENT inode, which is equally not ours to clobber. Never
            // overwrite and never unlink — leave the twin live and say so.
            return { ok: false, reason: 'archived-tombstone-differs' };
          }
          // Final re-proof: the inode we are about to unlink must STILL be the
          // generation we classified. (Belt-and-braces under the lock; the lock
          // itself is what makes this authoritative — see devswarm-child-turn.js.)
          if (a.dev !== before.dev || a.ino !== before.ino) {
            return { ok: false, reason: 'descriptor-changed-since-scan' };
          }
          fs.unlinkSync(activePath);
          return { ok: true };
        } catch (e) {
          return { ok: false, reason: 'retire-failed: ' + String((e && e.message) || e) };
        }
      });
      if (r && r.ok) out.retired.push(tid);
      else if (r && r.lockBusy) out.left.push({ id: tid, reason: 'lock-busy' });
      else out.left.push({ id: tid, reason: (r && r.reason) || 'retire-failed' });
    }
    return out;
  } catch (_) { return out; }
}

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
  // Set once, by the id-derived authority gate below, when an explicit
  // `--force-cross-project <id>` was accepted. Threaded to the PHYSICAL
  // ownership check further down because the two gates ask the SAME authority
  // question from two angles (registered project key vs persisted ownerKey) —
  // clearing only the first would leave the override cosmetic, the archive
  // still refused, and the defect unfixed.
  let crossProjectOverride = false;
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
    // ---- ID-DERIVED AUTHORITY GATE (defect e586afdaa968, P0) ----
    // Same rehome-then-validate inversion as the `ensure` branch, but this one
    // also REMOVES the live descriptor on success: archiving a hash-stranded
    // workspace whose worktree lives in ANOTHER project copied that project's
    // rows into this one and then retired its live descriptor. Refuse FIRST,
    // on the id's own registered key, so nothing is copied and — critically —
    // nothing is removed. Fail-open unchanged for a descriptor that names no
    // project at all.
    {
      const registeredRepoKeyForArchive = descriptorRegisteredRepoKey(desc, id);
      if (registeredRepoKeyForArchive && registeredRepoKeyForArchive !== currentRepoKey) {
        // c2a7813aa7d3: the ONE escape hatch. See forceCrossProjectOverride's
        // header for why it is opt-in, id-exact, audited, and archive-only.
        // `opts.flags` is supplied ONLY by the interactive `archive` CLI verb.
        // The BULK sweeps that also call cmdArchive (reap-stale, the archive
        // sweep) pass no flags and therefore can NEVER take this hatch — an
        // automated pass must not silently archive across projects.
        const override = forceCrossProjectOverride((opts && opts.flags) || {}, id);
        if (override.accepted) {
          crossProjectOverride = true;
          logAuthorityOverride({
            ts: new Date().toISOString(),
            verb: 'archive',
            id: String(id),
            cwdProject: currentRepoKey || null,
            targetProject: registeredRepoKeyForArchive,
          }, home);
        } else {
          const refusal = Object.assign(
            { action: 'archive', descriptorArchived: false },
            projectContextMismatch(id, registeredRepoKeyForArchive, currentRepoKey,
              'run this from within that project\'s worktree to archive it'));
          refusal.error += forceCrossProjectHint(id, override.provided, override.value);
          if (override.provided) refusal.forceCrossProjectRejected = override.value;
          return refusal;
        }
      }
    }
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
    if ((!ownerKey || ownerKey !== currentOwnerKey) && !crossProjectOverride) {
      return {
        ok: false, action: 'archive', id, descriptorArchived: false,
        error: 'descriptor does not belong to the current project',
      };
    }
    // An override can only fire when the id HAS a resolvable registered key, so
    // fall back to it rather than leaving `ownerKey` null and letting the
    // tombstone store open against an unspecified bucket.
    if (crossProjectOverride && !ownerKey) ownerKey = descriptorRegisteredRepoKey(desc, id) || currentOwnerKey;
    // CRITICAL under an override: `ownerKey` stays the workspace's OWN key and
    // is deliberately NOT re-stamped to the caller's. The registry tombstone
    // below opens its store with `hash: ownerKey`, so leaving it alone puts the
    // tombstone in the OWNING project's store, where it belongs. Re-homing the
    // descriptor to the caller's project instead would be precisely the
    // cross-project theft the authority gate exists to prevent — the override
    // authorises archiving a foreign workspace, never adopting one.
    if (activeState.exists && !storedOwnerKey && !crossProjectOverride) {
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
  // WHOLE-FAMILY DESCRIPTOR RETIRE — runs only after this id's own archive is
  // fully durable, so a failure here can never leave the primary half-applied.
  // Fail-open by construction (see retireIdentityFamilyDescriptors).
  const familyRetire = retireIdentityFamilyDescriptors(home, id, desc);
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
  // Same shape discipline as groupRetire: surfaced ONLY when it did something,
  // so a plain single-descriptor archive keeps its return byte-for-byte.
  if (familyRetire) {
    if (familyRetire.retired.length) archived.retiredFamilyDescriptors = familyRetire.retired;
    if (familyRetire.left.length) archived.leftFamilyDescriptors = familyRetire.left;
  }
  // R12 hygiene (c): a cross-project archive taken via the explicit hatch must
  // STATE its consequence, not just record it in a log nobody reads. Present
  // only on the override path, so an ordinary archive's shape is unchanged.
  if (crossProjectOverride) {
    archived.forceCrossProject = true;
    archived.warning = FORCE_CROSS_PROJECT_ORPHAN_WARNING;
  }
  return archived;
  });
}

// resolveArchiveId(raw, ctx) — id-PREFIX resolution for the `archive` verb
// ONLY. WHY: the per-turn table (devswarm-parent-inbox.js) and the roster
// both render `name (shortId)` (names.displayName/shortId — first 8 chars of
// the UUID) as the ONLY copyable-looking token; the real archivable id is the
// full UUID, shown nowhere. An agent/user copies the 8-char shortId and
// `archive <that>` fails 'invalid or missing workspace id'. This lets that
// same shortId (or any unambiguous longer prefix) resolve directly, WITHOUT
// adding a single new injection token to the rendered table — no full UUIDs
// are surfaced anywhere by this change.
//
// Contract (P0: archiving the WRONG workspace is the real risk, so ambiguity
// fails CLOSED — nothing is ever archived on an ambiguous prefix):
//   1. An EXACT existing descriptor id (active OR archived-only) short-circuits
//      immediately — unchanged full-id behaviour, zero prefix search performed.
//   2. Else the candidate pool is the CURRENT PROJECT's own active (non-
//      archived) workspace ids — same `sum.workspaces` projection
//      cmdWorkspacesList/the roster/the table already read (computeSummary
//      excludes archived ids by construction), scoped by the SAME repoKey
//      derivation cmdWorkspacesList uses. This deliberately mirrors cmdArchive's
//      own ownership gate ('descriptor does not belong to the current
//      project') — a prefix can only ever resolve to a workspace this project
//      could legitimately archive anyway.
//   3. Exactly one candidate id starts with `raw` -> resolved, use it.
//   4. Zero, or `raw` itself is not isSafeId (e.g. contains '/' or '..') ->
//      the existing 'invalid or missing workspace id' error, unchanged.
//   5. Two or more -> ARCHIVE NOTHING; return an error listing every
//      candidate's full id so the caller can pick the exact one.
// Never throws; every path returns { ok, id? , error?, candidates? }.
function resolveArchiveId(raw, ctx) {
  if (!isSafeId(raw)) return { ok: false, error: 'invalid or missing workspace id' };
  const home = ctx.home;
  // Step 1: exact id short-circuit (active OR archived-only descriptor) — no
  // prefix search, no ambiguity possible, byte-identical to pre-existing
  // full-id archive behaviour.
  if (readDescriptorPathState(descriptorPath(home, raw)).exists) return { ok: true, id: raw };
  const archiveDirState = checkedArchivedDir(home, { create: false });
  if (archiveDirState.ok) {
    const archivedPath = path.join(archiveDirState.path, raw + '.json');
    if (readDescriptorPathState(archivedPath).exists) return { ok: true, id: raw };
  }
  // Step 2: candidate pool = current project's active workspaces, same
  // derivation cmdWorkspacesList uses (cwd-derived worktree -> repoKey).
  let candidates = [];
  try {
    const worktree = inst.resolveWorktree(ctx.cwd || process.cwd());
    const workspaceId = worktree ? inst.primaryWorkspaceId(worktree) : undefined;
    const repoKey = worktree ? repokey.repoKeyForWorktree(worktree) : repoKeyForCwd(ctx);
    const s = store.openStore({ home, workspaceId, hash: repoKey || undefined, backend: ctx.backend, env: ctx.env });
    let sum;
    try { sum = store.computeSummary(s, { home, env: ctx.env, now: ctx.now }); }
    finally { s.close(); }
    candidates = Object.keys(sum.workspaces || {}).filter((wid) => isSafeId(wid) && wid.startsWith(raw));
  } catch (_) {
    candidates = []; // fail-closed: an unresolvable project context yields no candidates, not a crash
  }
  if (candidates.length === 1) return { ok: true, id: candidates[0] };
  if (candidates.length === 0) return { ok: false, error: 'invalid or missing workspace id' };
  return {
    ok: false,
    error: 'ambiguous workspace id prefix ' + JSON.stringify(raw) + ' matches ' + candidates.length
      + ' workspaces — archived nothing; use the full id: ' + candidates.join(', '),
    candidates,
  };
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

// REASON_MAX_LEN — a stated-intent reason is stored verbatim (never echoed
// back into any injected hook output — see devswarm-parent-gate.js's
// buildReason) but is still bounded so a runaway/pasted-in caller can never
// grow the tiny per-session state file unreasonably.
const REASON_MAX_LEN = 2000;

// cmdGateIntent(flags, ctx) — `gate-intent --reason "<text>" [--session <id>]`
// (PLAN.md CLI VERB CONTRACT precedent, same shape as cmdSkip above): the
// EXPLICIT, deliberate signal devswarm-parent-gate.js's Stop-hook gate
// consumes to distinguish "the Primary stated a reason for this exact
// neglect condition" from "the Primary is simply ignoring the gate" — see
// that hook's `intents`/`intentAcks` handling. A CLI verb (rather than
// scanning the transcript tail for a hedge phrase the way merge-gate.js
// does) was chosen because the signal here needs to be UNAMBIGUOUS and
// per-condition-scoped: merge-gate.js's keyword heuristic works for its
// narrow backstop role (bypassable, honestly documented, default-off) but a
// keyword match against free-form assistant text has no reliable way to
// bind itself to ONE specific blocking signature — it would either fire on
// every Stop once any hedge-like phrase appeared anywhere in the tail
// (falsely covering an unrelated future block) or need its own second
// scanner/state machine duplicating this file's existing sig-keyed
// bookkeeping. A CLI call the Primary explicitly issues IN RESPONSE to a
// block is unambiguous, requires no wording heuristic, and reuses the
// gate's own already-persisted `sig` as the binding key for free.
//
// Session resolution mirrors cmdRegisterPrimary's own precedent (see its
// comment above): `--session` explicit override, else the real
// CLAUDE_CODE_SESSION_ID Claude Code sets on every spawned process, else the
// legacy DEVSWARM_BUILDER_ID fallback. Unlike register-primary this verb has
// NO further fallback to a derived id — an intent with no resolvable session
// has nothing to key its per-session state file by, so it fails visibly
// (`ok:false`) rather than silently guessing wrong.
//
// The intent can only ever be attached to a signature the gate has ALREADY
// persisted (i.e., the Primary has already been blocked at least once this
// session) — reading `sig` from the SAME state file
// devswarm-parent-gate.js's Stop hook already writes, never re-deriving the
// blocking-set signature itself (that computation needs descriptors/
// liveness/store reads this thin CLI verb has no reason to duplicate). No
// active block yet -> `ok:false`, nothing written — this is exactly what
// keeps the gate's OWN "never suppress the first block" guarantee intact:
// an intent can never predate the block it is meant to acknowledge.
function cmdGateIntent(flags, ctx) {
  const home = ctx.home;
  const session = one(flags, 'session')
    || (ctx.env && ctx.env.CLAUDE_CODE_SESSION_ID)
    || (ctx.env && ctx.env.DEVSWARM_BUILDER_ID);
  if (!session) {
    return { ok: false, error: 'gate-intent needs a resolvable session id (CLAUDE_CODE_SESSION_ID not set in this environment; pass --session <id> explicitly)' };
  }
  const rawReason = one(flags, 'reason');
  const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
  if (!reason) {
    return { ok: false, error: 'gate-intent needs --reason "<text>" (a non-empty stated reason)' };
  }
  const gateState = require('../companion/lib/devswarm-gate-state.js');
  const stateFile = gateState.stateFileFor(session, home);

  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_) {
    existing = null; // no state file yet, or unreadable/corrupt -> no active block to attach to
  }
  const sig = existing && typeof existing === 'object' && typeof existing.sig === 'string' ? existing.sig : '';
  if (!sig) {
    return {
      ok: false,
      error: 'no active devswarm-parent-gate block is recorded for session ' + JSON.stringify(session) +
        ' — an intent can only be attached to a condition the gate has already surfaced at least once',
    };
  }

  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const truncatedReason = reason.length > REASON_MAX_LEN ? reason.slice(0, REASON_MAX_LEN) : reason;
  const nextIntents = {};
  nextIntents[sig] = { ts: now, reason: truncatedReason };
  // Everything else in the existing state file is preserved verbatim — this
  // verb only ever ADDS/replaces the `intents` entry for the CURRENT sig; it
  // never touches blocks/escalated/qSig/etc (those stay the gate hook's own
  // bookkeeping) and never deletes the file.
  const next = Object.assign({}, existing, { intents: nextIntents });

  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    return { ok: false, error: 'failed to persist gate-intent: ' + (e && e.message ? e.message : String(e)) };
  }

  return { ok: true, action: 'gate-intent', session, sig, ts: now };
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
    // Defect-2(b) fix: a live descriptor whose worktree no longer exists on
    // disk, and which ALREADY has an archived/ counterpart for this same id
    // (archived but never pruned — the exact stale-descriptor shape this
    // sweep must not treat as live), is skipped here. Detect-only: never
    // deletes/unlinks the stale live descriptor — that pruning decision is
    // left for the owner. Guards against wasting a rehome attempt (or any
    // future side effect) on a descriptor that structurally can't be a real
    // live target.
    let worktreeExists = true;
    try { worktreeExists = fs.existsSync(desc.worktreePath); } catch (_) { worktreeExists = true; }
    if (!worktreeExists && hasArchivedCounterpart(home, id)) continue;
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
// meshCandidateRows(storeHandle, meshId) -> registry rows whose CANONICAL
// (git-toplevel-resolved) meshId matches `meshId`.
//
// TRACED P0 DEFECT B fix: this used to match on the RAW stored worktreePath
// hash (`inst.primaryWorkspaceId(d.worktreePath)`), while `diagnose` groups
// via `canonicalMeshId` (git-toplevel-resolved, `groupRegistryByMeshId`
// above). A subdir-registered row's raw-path hash differs from its
// toplevel's canonical meshId, so it was inside diagnose's group but NOT a
// send candidate for that same meshId — `send` and `diagnose` disagreed
// about group membership for the exact same row.
//
// Fix chosen: unify HERE, on canonicalMeshId, rather than mutating the
// registry via `rekeySubdirRegistryRows` on the send path. `meshId` values
// callers actually pass to `--to` come from `roster`/`diagnose` output,
// which are ALREADY canonical (both key off `groupRegistryByMeshId` /
// `canonicalMeshId`) — so comparing each row's canonical meshId against that
// argument is the correct, already-intended join, and it is a PURE
// per-call computation: no registry write, no lock, no risk of a lost-update
// race with a concurrent register/heartbeat/rehome (rekeySubdirRegistryRows
// explicitly documents that hazard for its own in-place write path). The
// data-repair alternative (running rekeySubdirRegistryRows here) was
// rejected: it would require taking a per-id lock and performing a registry
// write on every `send` for a case that is purely a read-side identity
// mismatch, and it already runs independently via foldMeshDuplicates (doctor
// repair / reconcile), which self-heals stored subdir rows over time — this
// fix does not depend on that repair having already run.
function meshCandidateRows(storeHandle, meshId) {
  const candidates = [];
  if (!meshId) return candidates;
  for (const d of storeHandle.listRegistry()) {
    if (!d || !d.worktreePath) continue;
    let canon = null;
    try { canon = canonicalMeshId(d.worktreePath); } catch (_) { canon = null; }
    if (canon !== String(meshId)) continue;
    candidates.push(d);
  }
  return candidates;
}

function resolveMeshTarget(storeHandle, meshId, home) {
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
  // success. Matching by worktree-derived meshId stays local (needs `inst`); the
  // actual freshest-LIVE selection is delegated to devswarm-liveness-select.js's
  // pickFreshestLive — the SAME evidence-based ranking (session-reference integrity,
  // drain activity, session-authored heartbeat, THEN updatedAt/cursor recency) also
  // used by pickSurvivor and devswarm-store.js's resolveSenderRegistryId (P0-A: a
  // plain recency window can NEVER exclude a dead row whose updatedAt is kept fresh
  // by an unrelated `heartbeat` caller — see that module's header for the field
  // evidence). `home` is optional (enables the heartbeat-credit signal only; every
  // other signal works without it).
  //
  // D11-A (f56dcc08f048): the LIVE-candidate gate pickFreshestLive applies is now
  // isRoutingLiveRowStrict (via opts.isLive), not the bare isLiveSessionId shape
  // test — see that function's header (the STRICT, no-descriptor-fallback
  // variant: a dead store-only row's lingering descriptor must never win a
  // `send` target). devswarm-store.js's resolveSenderRegistryId does NOT pass
  // opts.isLive, so it keeps pickFreshestLive's own default (bare
  // isLiveSessionId) unchanged — this migration is scoped to send/fold routing
  // only, per the header comment above SYNTHETIC_SESSION_PREFIX.
  const candidates = meshCandidateRows(storeHandle, meshId);
  return livenessSelect.pickFreshestLive(candidates, {
    storeHandle, home,
    isLive: (row) => isRoutingLiveRowStrict(row, home),
  });
}

// resolveMeshPartitionIds(storeHandle, id, worktreePath) ->
//   { meshPartitionIds, meshUnionActive, meshGroupUnresolved, meshGroupError }
//
// THE single authority for "which store partitions belong to this workspace
// id" — the question underlying defect 27cd80902435 (two registry rows share
// one meshId; 372 real messages sat unread in the row nothing read). Wraps
// canonicalMeshId + meshCandidateRows verbatim — the SAME grouping primitive
// `send --to-primary` (resolveMeshTarget, above) and `diagnose` (meshTargets)
// already use, so send/diagnose/every inbox read verb agree on ONE group,
// never a second, drifting definition.
//
// Extracted from cmdInboxMessages's own inline mesh-widening block (the
// v0.82.0/14c73f9 fix for read-primary/peek-primary/--ack) so
// `count`/`read`/`ack`/plain `messages` (this defect's remaining gap) can
// reuse the identical resolution instead of a parallel implementation.
//
// Fail-open by construction: `worktreePath` falsy, no meshId, a single-row
// group, or `id` itself missing from its own resolved group all leave
// meshPartitionIds at just [String(id)] (meshUnionActive:false) — the
// pre-fix single-partition behavior. A THROWN resolution (corrupt registry
// row, canonicalMeshId throw, etc — P1b) narrows the SAME way but is
// reported via meshGroupUnresolved/meshGroupError so a caller can tell
// "resolved cleanly, no siblings exist" apart from "enumeration itself
// failed, this read may be partial" — never silently indistinguishable.
function resolveMeshPartitionIds(storeHandle, id, worktreePath) {
  let meshPartitionIds = [String(id)];
  let meshUnionActive = false;
  let meshGroupUnresolved = false;
  let meshGroupError = null;
  try {
    const meshId = worktreePath ? canonicalMeshId(worktreePath) : null;
    if (meshId) {
      const candidates = meshCandidateRows(storeHandle, meshId);
      const ids = Array.from(new Set((candidates || []).map((r) => String(r.id))));
      if (ids.length > 1 && ids.indexOf(String(id)) !== -1) {
        meshPartitionIds = ids;
        meshUnionActive = true;
      }
    }
  } catch (e) {
    meshPartitionIds = [String(id)];
    meshUnionActive = false;
    meshGroupUnresolved = true;
    meshGroupError = String((e && e.message) || e);
  }
  return { meshPartitionIds, meshUnionActive, meshGroupUnresolved, meshGroupError };
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
function resolveSendTarget(storeHandle, arg, home) {
  const byMesh = resolveMeshTarget(storeHandle, arg, home);
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
    // canonicalMeshId (not the raw-path inst.primaryWorkspaceId) — kept consistent
    // with resolveMeshTarget/meshCandidateRows' matching so this shadow-guard
    // check agrees with the same identity byMesh was just derived from.
    try { ownMeshId = idMatches[0].worktreePath ? canonicalMeshId(idMatches[0].worktreePath) : null; } catch (_) { ownMeshId = null; }
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
  // D11-A (d35d2d4b241e): callerIdentityDetailed gives the SAME resolution as
  // callerIdentity (identical resolveCallerWorktree -> DEVSWARM_BUILDER_ID ->
  // raw-cwd-hash fallback order) plus the `kind` this send's success/refusal
  // JSON now surfaces additively — computed once here instead of calling
  // callerIdentity separately.
  const fromDetailed = callerIdentityDetailed(ctx.env, cwd);
  const from = fromDetailed.identity;
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

  // FIX 4a (TRACED): argv is the ONLY way to pass a message body, forcing callers
  // to correctly quote shell metacharacters (backticks/`$` expand in the CALLER's
  // shell — not an anti-hall vulnerability, but a real usability gap). Add
  // --message-file <path> and --message-stdin as byte-exact alternatives, reusing
  // the existing fd-0 read idiom (`--stdin` on reconcile-active). Mutually
  // exclusive with --message and with each other.
  const messageFlag = one(flags, 'message');
  const messageFileFlag = one(flags, 'message-file');
  const messageStdinFlag = hasFlag(flags, 'message-stdin');
  const messageSourceCount = (messageFlag !== undefined ? 1 : 0)
    + (messageFileFlag !== undefined ? 1 : 0) + (messageStdinFlag ? 1 : 0);
  if (messageSourceCount > 1) {
    return { ok: false, error: 'send accepts exactly one of --message, --message-file, or --message-stdin' };
  }
  if (messageSourceCount === 0) {
    return { ok: false, error: 'send requires exactly one of --message TEXT, --message-file <path>, or --message-stdin' };
  }
  let message;
  if (messageFileFlag !== undefined) {
    try { message = fs.readFileSync(messageFileFlag, 'utf8'); }
    catch (e) { return { ok: false, error: 'send --message-file ' + JSON.stringify(messageFileFlag) + ' could not be read: ' + String(e && e.message || e) }; }
  } else if (messageStdinFlag) {
    if (ctx.io && typeof ctx.io.stdin === 'string') message = ctx.io.stdin;
    else { try { message = fs.readFileSync(0, 'utf8'); } catch (e) { return { ok: false, error: 'send --message-stdin could not read fd 0: ' + String(e && e.message || e) }; } }
  } else {
    message = messageFlag;
  }
  if (!message) return { ok: false, error: 'send requires --message TEXT (or --message-file/--message-stdin) with a non-empty body' };

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
    // TRACED P0 DEFECT B fix (step 1): `send` used to resolve+deliver to exactly
    // one row with ZERO visibility into whether the candidate set it picked from
    // had more than one row (a partition). REPORT, never block — a partition is
    // exactly the shape where refusing to send would be worse than delivering to
    // the freshest-live candidate. `candidateMeshRow` is whichever row resolution
    // actually picked (toPrimaryFlag's `target` or the toFlag path's
    // `resolved.target`); candidate count is recomputed from ITS OWN canonical
    // meshId group (meshCandidateRows) so this is correct whether the row was
    // found via the meshId match or the exact-id fallback in resolveSendTarget.
    let candidateMeshRow = null;
    if (type === 'direct') {
      // Fail-closed addressing (D12a): a --to naming neither a registered meshId
      // NOR a registered row id is rejected outright — never a silent
      // black-hole. Same posture for --to-primary: an unregistered Primary is a
      // fail-closed error, never a silent black-hole either. After a re-home
      // (above) the Primary's row is now in THIS repoKey store, so this resolve
      // finds it.
      if (toPrimaryFlag) {
        const target = resolveMeshTarget(s, primaryMeshId, home);
        if (!target) {
          return {
            ok: false, reason: 'primary-unregistered',
            error: 'send --to-primary: no registered Primary workspace for this project (run `register-primary` first)',
          };
        }
        targetPartition = target.id;
        candidateMeshRow = target;
      } else {
        // resolveSendTarget (P0 addressing fix): tries the meshId match FIRST
        // (unchanged), then falls back to an exact match against a row's own
        // `id` — the value `roster` now prints alongside meshId, so a copied
        // roster id addresses correctly instead of failing closed.
        const resolved = resolveSendTarget(s, toFlag, home);
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
        candidateMeshRow = resolved.target;
      }
    }
    // Candidate-set size for the resolved row's OWN canonical meshId group —
    // >1 means the meshId this send addressed had more than one registry row
    // (a partition); pickFreshestLive already chose `targetPartition` from
    // among them. undefined (not 0) for a broadcast/no-target send, so the
    // field is only present when it means something.
    let candidateCount;
    if (type === 'direct' && candidateMeshRow) {
      try {
        const meshForCount = canonicalMeshId(candidateMeshRow.worktreePath);
        candidateCount = meshCandidateRows(s, meshForCount).length;
      } catch (_) { candidateCount = undefined; }
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
      // READBACK VERIFICATION (defect 84c0b4385f68, REOPENED): better-sqlite3's
      // INSERT is synchronous, so the row physically exists on disk the instant
      // appendMeshMessage() returns — but that was never proof a READER can see
      // it (the v0.77.0 `bytes`/`hash` echo below was flagged by its own comment
      // as "purely additive", i.e. it never actually re-read anything). Re-select
      // the exact partition this send targeted (workspace_id) and confirm the row
      // is present by its unique `hash` (table-wide UNIQUE(hash) constraint,
      // devswarm-store.js:414) — through s.listMessages(), the SAME read path
      // read-primary/peek-primary/inbox messages use, so this proves readability
      // through the real read surface, not a special-cased check. Cheap in the
      // common case: a fresh append is virtually always the LAST row (id ASC),
      // so that's checked first; the full-scan fallback only runs if that misses
      // (e.g. a concurrent writer landed a row after this one).
      const verifyPartition = type === 'direct' ? targetPartition : store.BROADCAST_PARTITION_ID;
      let verified = false;
      let verifyError = null;
      try {
        const rows = s.listMessages(verifyPartition) || [];
        const last = rows.length ? rows[rows.length - 1] : null;
        verified = !!(last && last.hash === hash) || rows.some((r) => r && r.hash === hash);
      } catch (e) {
        // Fail-open on the VERIFICATION step itself only (its own read threw) —
        // report unverified, never claim absence, never claim failure.
        verifyError = String((e && e.message) || e);
      }
      const out = {
        // ok stays true unless the readback POSITIVELY shows the row absent
        // (verifyError is null and verified is false) — a verification error
        // never flips ok:false (fail-open on the check itself, per spec).
        ok: verified || verifyError !== null,
        action: 'send', from,
        // D11-A (d35d2d4b241e): ADDITIVE — surface callerIdentityDetailed's
        // `kind` (resolved/declared/unresolvable) alongside `from`.
        identity: { id: from, kind: fromDetailed.kind },
        to: type === 'direct' ? (toPrimaryFlag ? primaryMeshId : toFlag) : null, type, urgency,
        sent: !!res.inserted, seq: res.seq,
        // FIX 3 (TRACED, purely additive): echo the integrity data already computed
        // above so `ok:true` is verifiable without a read-back-and-tail-compare.
        // defect 0960924d28be: this was `String(message).length` — UTF-16 CODE
        // UNITS, not bytes. Every multi-byte codepoint (an em dash U+2014 is 3
        // UTF-8 bytes but 1 UTF-16 unit) under-reported by exactly (utf8Bytes -
        // utf16Units), which the field report reconciled to the codepoint on two
        // independent sends (5807->5805 with 1 em dash, 3760->3756 with 2). The
        // field reading of that gap was "the body was TRUNCATED in transit" — a
        // false data-loss alarm from a purely cosmetic measurement bug. A field
        // named `bytes` must report BYTES. This is the ONLY size measurement in
        // this file (verified: no other `bytes:`/byteLength site exists here);
        // companion/devswarm-ingest.js:816/1483 already used Buffer.byteLength
        // for its quarantine cap, so no cap/limit anywhere shared the wrong
        // measure and nothing else needed changing.
        bytes: Buffer.byteLength(String(message), 'utf8'),
        hash,
        rehomedFromHashBucket: rehomedSend || undefined,
        needsReply: questionFlag,
        toId: type === 'direct' ? targetPartition : null,
        // TRACED P0 DEFECT B (step 1): visibility into the candidate set this
        // send resolved from — >1 means the target meshId's group is
        // partitioned (never blocks; report-only).
        candidates: type === 'direct' ? candidateCount : undefined,
        // ADDITIVE (defect 84c0b4385f68): the readback verification result.
        // `verified:true` means the row was actually confirmed readable in its
        // target partition. `verified:false` with `verifyError` set means the
        // check itself errored (unknown, not a failure). `verified:false` with
        // `verifyError:null` means the readback POSITIVELY found the row
        // absent — a real delivery failure, surfaced via `ok:false` + `reason`
        // above/below rather than a silent `ok:true`.
        verified,
      };
      // SEND RECEIPT (v0.90.0). An on-disk record that this send happened,
      // written by the SENDER at the moment of the append.
      //
      // WHY: devswarm-parent-reply-tracker.js (PostToolUse/Bash) can only learn
      // that the Primary replied by PARSING the send's stdout — which means a
      // send whose stdout it cannot parse (a compound command's interleaved
      // output, a redirect, a wrapper that swallows stdout, a send issued from
      // anywhere other than a Bash tool call) silently never counts as a reply,
      // and the sender's question stays "unanswered" forever. A receipt is
      // written by the send ITSELF, so the tracker no longer depends on the
      // shape of the surrounding shell command.
      //
      // FAIL-SOFT AND OUT OF BAND: wrapped whole, and its result is never read
      // — `out` is returned unchanged whether the receipt landed or not. A
      // receipt is a diagnostic, never part of delivery.
      //
      // P1 (Round 13): the receipt carries its PROJECT. Without it the reader
      // (devswarm-parent-reply-tracker.js) credited EVERY receipt in the home
      // directory to whatever repoKey the CURRENT payload resolved to — a send
      // in project A silently cleared a pending question in project B, because
      // receipts are home-scoped while reply-state is per-project. `cwd` is
      // recorded alongside it purely as a human-readable provenance field.
      writeSendReceipt(home, {
        ts: now, from, to: out.to, toId: out.toId, type, urgency,
        hash, bytes: out.bytes, ok: out.ok, sent: out.sent,
        needsReply: questionFlag, verified,
        repoKey: repoKey != null ? String(repoKey) : null,
        cwd: cwd != null ? String(cwd) : null,
      });
      if (verifyError !== null) out.verifyError = verifyError;
      if (!verified && verifyError === null) {
        out.reason = 'send-not-verified';
        out.error = 'send appended a row (hash ' + hash + ') but the readback against partition '
          + JSON.stringify(verifyPartition) + ' did not find it — the message is NOT confirmed delivered';
      }
      return out;
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

// ===========================================================================
// SEND RECEIPTS (v0.90.0) — <devswarmRoot>/send-receipts/<YYYY-MM-DD>/<hash>.json
//
// One small JSON file per send, date-partitioned so a reader can scan just
// today's directory and a retention sweep can drop whole days (doctor-repair's
// sweepSendReceipts, 7-day default). The file NAME is the send's content hash,
// which makes the write idempotent: a retried identical send overwrites its own
// receipt rather than accumulating duplicates.
function sendReceiptsDir(home) { return path.join(devswarmRoot(home), 'send-receipts'); }

// receiptDayKey(ts) -> 'YYYY-MM-DD' in UTC. UTC, not local time, so a reader
// scanning "today" agrees with the writer regardless of the two processes'
// timezones (and so a DST shift can never make a day directory ambiguous).
function receiptDayKey(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  return d.toISOString().slice(0, 10);
}

// receiptFileName(hash) — the hash with every character outside [A-Za-z0-9_-]
// replaced, so a hash namespace prefix (`mesh:`, `native:`, `legacy:`) can never
// produce a path separator or a reserved character.
function receiptFileName(hash) {
  return String(hash == null ? 'nohash' : hash).replace(/[^A-Za-z0-9_-]/g, '_') + '.json';
}

// writeSendReceipt(home, entry) -> string|null (the path written, or null).
// NEVER THROWS: every step is inside one guard, and the return value is
// deliberately ignorable — the caller (cmdSend) must be unaffected either way.
// Atomic (tmp + rename) so a reader can never observe a half-written receipt.
function writeSendReceipt(home, entry) {
  try {
    const ts = Number.isFinite(entry && entry.ts) ? entry.ts : Date.now();
    const dir = path.join(sendReceiptsDir(home), receiptDayKey(ts));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, receiptFileName(entry && entry.hash));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, entry, { ts })) + '\n');
    fs.renameSync(tmp, file);
    return file;
  } catch (_) { return null; }
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

// ===== APP-SIDE ARCHIVE PROBE, BY ABSENCE (owner archived children in the app)
// `hivecontrol workspace list all` is the app's OWN view of which workspaces it
// still considers live. anti-hall never read it, so a workspace the owner
// archived IN THE APP kept rendering as escalated/stale here (nothing writes
// anti-hall's own `archived/<id>.json` in that flow — see
// companion/lib/devswarm-archived-cache.js's header).
//
// NO FIELD TO PIN — THIS IS A MEMBERSHIP QUERY. An earlier revision probed for an
// `archived`/`isArchived`/`status`/`isHidden`/`isActive` field on the records.
// MEASURED against the installed CLI (hivecontrol 2.5.1), every record carries
// EXACTLY {id, branch, sourceBranch, repositoryId, label, aiAgent, worktreePath,
// createdAt} and the subcommand accepts no filter flags, so that probe could
// never write an entry. What the list expresses is membership: an archived
// workspace stops being listed. This function therefore returns the ACTIVE set
// verbatim and the ABSENCE rule lives in the cache lib, where the freshness,
// repos-root and grace conjuncts that make absence safe live with it.

// fetchActiveWorkspaceRecords(ctx) ->
//   { ok:true, records:[{id, worktreePath}], count } | { ok:false, reason, rawKeys? }
// ONE bounded, read-only `hivecontrol workspace list all` spawn (the same verb,
// timeout and injectable io.run posture as fetchTrustedRepositoryId /
// cmdReconcileRegistry). Never throws. Called ONLY from the supervisor's
// cooldown-gated reconcile sweep — never from a hook or any every-turn path.
//
// AN EMPTY LIST IS NOT `ok`. Under the field-flag design an empty array was a
// legitimate "nothing archived" answer. Under absence semantics it would assert
// "this project has NO live workspaces", i.e. that every registry row is
// archived — the exact over-suppression this feature must never produce, and
// indistinguishable here from an error the CLI reported as an empty body. So a
// zero-record list reports `hivecontrol-empty-list` and the caller writes
// nothing, which suppresses nothing.
function fetchActiveWorkspaceRecords(ctx) {
  const c = ctx || {};
  const run = (c.io && c.io.run) || pull.defaultRun;
  let res;
  try {
    res = run({ args: ['workspace', 'list', 'all'], env: c.env, cwd: c.cwd || process.cwd(), timeout: LIST_CHILDREN_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, reason: 'hivecontrol-unavailable', error: String((e && e.message) || e) };
  }
  if (!res || !res.ok) return { ok: false, reason: 'hivecontrol-unavailable', error: String((res && res.error) || 'no output') };
  let parsed;
  try { parsed = JSON.parse(res.raw); } catch (_) { return { ok: false, reason: 'hivecontrol-shape-unrecognized', rawKeys: [] }; }
  // The measured shape is a FLAT ARRAY. `{children:[...]}` is accepted too, the
  // same tolerance cmdReconcileRegistry already applies to this CLI's output.
  const rawList = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.children) ? parsed.children : null);
  if (!rawList) {
    return { ok: false, reason: 'hivecontrol-shape-unrecognized',
      rawKeys: (parsed && typeof parsed === 'object') ? Object.keys(parsed) : [] };
  }
  const records = [];
  for (const e of rawList) {
    if (!e || typeof e !== 'object' || e.id == null || String(e.id) === '') continue;
    records.push({
      id: String(e.id),
      worktreePath: typeof e.worktreePath === 'string' && e.worktreePath ? e.worktreePath : null,
    });
  }
  if (!records.length) return { ok: false, reason: 'hivecontrol-empty-list', records: 0 };
  return { ok: true, records, count: records.length };
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
// rosterLastOutboundTs(home, id) -> ms | null. The persisted liveness verdict's
// raw lastOutboundTs (the same file rosterIdleDays reads, before the day
// conversion). null when absent / unreadable / missing the field — never a
// fabricated value.
function rosterLastOutboundTs(home, id) {
  try {
    const v = JSON.parse(fs.readFileSync(livenessPathFor(id, home), 'utf8'));
    if (v && Number.isFinite(v.lastOutboundTs)) return v.lastOutboundTs;
  } catch (_) { /* no verdict yet / unreadable — fail-open */ }
  return null;
}

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
// `opts` (optional): { repoKey, env, cache } for the APP-SIDE archive check —
// the DevSwarm app's own archived list, cached by the supervisor. Omitted (or
// without a repoKey) the check is simply skipped, which is the pre-existing
// behavior — this can only ever ADD an `archived` hint, never remove one.
function rosterHints(home, id, worktreePath, now, sessionId, opts) {
  const hints = [];
  if (worktreePath && !fs.existsSync(worktreePath)) hints.push('worktree-gone');
  const idleDays = rosterIdleDays(home, id, now);
  if (idleDays !== null) hints.push('idle ' + idleDays + 'd');
  // FIELD (archived rows still alerting): an ARCHIVED workspace is done and put
  // away — it is still listed, but it is labelled `archived` and never carries
  // the dormant/idle-alive liveness annotation (see companion/lib/
  // devswarm-archived.js for why archived/<id>.json alone is not the test).
  let archived = false;
  try { archived = isArchivedWorkspace(home, id, worktreePath); } catch (_) { archived = false; }
  // APP-SIDE archive (field): the owner archived the workspace in the DevSwarm
  // app, which never writes anti-hall's own archived/<id>.json. Read-only, from
  // the supervisor-written ACTIVE-set cache, and app-archived only when all four
  // of that lib's absence conjuncts hold (fresh cache, worktree under the
  // DevSwarm repos root, absent from the active set by BOTH id and worktreePath,
  // and older than the snapshot by the grace). `worktreePath` is passed because
  // conjuncts 2 and 3 are both defined on it. Same liveness-axis-only effect as
  // the local check: the row is still listed in full, it just stops carrying
  // dormant/idle-alive.
  if (!archived && opts && opts.repoKey) {
    try {
      archived = archivedCacheLib.isAppArchived({
        home, repoKey: opts.repoKey, id, worktreePath, env: opts.env, cache: opts.cache, now,
      });
    } catch (_) { archived = false; }
  }
  if (archived) { hints.push('archived'); return hints; }
  // `dormant` / `idle (alive)` — rowLivenessState (companion/lib/liveness.js),
  // THE ONE read-side dormancy rule, shared with devswarm-parent-inbox.js's
  // per-turn injection so the roster and the UserPromptSubmit table can never
  // disagree about which rows are still transacting. It picks the tight dormant
  // window when this row's transcript term resolves, or the wide idle window
  // when it doesn't (the common case) — see isDormantRow's own doc for why —
  // and then applies the SESSION-SOURCED axis (defect 699a236129c5): a row whose
  // sessionId maps to a RUNNING harness process is `idle (alive)`, surfaced
  // distinctly instead of being mislabelled dormant. Annotation ONLY: the row is
  // still listed in full. Fail-open — no signal at all means UNKNOWN, which is
  // never dormant.
  try {
    const state = rowLivenessState(
      { id, worktreePath, sessionId: sessionId || null },
      home,
      { now, lastOutboundTs: rosterLastOutboundTs(home, id) }
    );
    if (state === 'dormant') hints.push('dormant');
    else if (state === 'idle-alive') hints.push('idle (alive)');
  } catch (_) {}
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
  // ONE read of the app-side ACTIVE-set cache for the whole roster (freshness is
  // applied inside readActiveCache — stale/missing/malformed yields nothing).
  let appArchivedCache = null;
  try { appArchivedCache = archivedCacheLib.readActiveCache({ home, env: ctx.env, now }); } catch (_) { appArchivedCache = null; }
  const workspaces = Object.values(sum.workspaces || {}).map((w) => {
    // DEMOTE (archived-still-active fix): a store-sourced row whose workspace is
    // genuinely archived is labeled source:'archived' + hinted, instead of being
    // reported as a live 'store' row. The row is still SHOWN (nothing is hidden
    // or deleted — same no-delete posture as the archived/ scan below); only its
    // label changes, so an archived workspace can no longer read as active.
    const archivedOnly = isArchivedOnlyWorkspace(home, w.id);
    const hints = rosterHints(home, w.id, w.worktreePath, now, w.sessionId, { repoKey, env: ctx.env, cache: appArchivedCache });
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
      hints: rosterHints(home, id, child.path || null, now, null, { repoKey, env: ctx.env, cache: appArchivedCache }), // native hivecontrol child has no mesh descriptor / sessionId
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
            hints: rosterHints(home, pw.id, pw.worktreePath, now, pw.sessionId, { repoKey: fallbackHash, env: ctx.env, cache: appArchivedCache }),
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
  const byMesh = groupRegistryByMeshId(registry, c.home);
  const meshTargets = [];
  const splits = [];
  const deadSplits = [];
  const mixedSplits = [];
  // TRACED P0 fix: the predicate used to be two INDEPENDENT checks —
  // `liveSplit = liveRows>=2` and `deadSplit = rows.length>=2 && liveRows===0`
  // — which left EXACTLY ONE shape uncovered: `rows.length>=2 && liveRows===1`
  // (one live row, one+ dead rows sharing a meshId). Neither check matched it,
  // so it scored split:false/deadSplit:false/splits:[] — invisible, even
  // though `send` can resolve to either row and a stranded child never
  // receives mail routed to the dead one (field-reported: meshId
  // `primary-bf04dd47`, liveRows:1, splits:[] while sends had to be
  // redirected to a live partition UUID). Fixed by classifying from ONE
  // predicate: any group with `rows.length >= 2` IS partitioned, and its
  // KIND is derived from liveRows — `live` (2+ live, may be benign, e.g. two
  // live tabs), `mixed` (exactly 1 live — the previously-invisible dangerous
  // shape, mail CAN reach the live row but a second send picking the dead
  // row strands), `dead` (0 live — HAZARD 2, nobody draining either row).
  // `splits`/`deadSplits`/`split`/`deadSplit` keys are PRESERVED byte-
  // identical for existing consumers (docs/KB-devswarm-hivecontrol.md,
  // healthcheckHumanLine, cmdHealthcheck's `degraded` gate) — `kind` and
  // `mixedSplit`/`mixedSplits` are ADDED alongside, never replacing them.
  // try/catch keeps this fail-open — a throw here must never block
  // diagnose/healthcheck.
  for (const g of byMesh.values()) {
    let target = null;
    let liveSplit = false;
    let deadSplit = false;
    let mixedSplit = false;
    let kind = null; // 'live' | 'mixed' | 'dead' | null (not partitioned — <2 rows)
    try {
      target = resolveMeshTarget(s, g.meshId, c.home); // the partition `send --to <meshId>` lands in
      if (g.rows.length >= 2) {
        if (g.liveRows >= 2) { kind = 'live'; liveSplit = true; }
        else if (g.liveRows === 1) { kind = 'mixed'; mixedSplit = true; }
        else { kind = 'dead'; deadSplit = true; }
      }
    } catch (_) { target = null; liveSplit = false; deadSplit = false; mixedSplit = false; kind = null; }
    const split = liveSplit; // preserved meaning: unchanged for existing consumers
    if (liveSplit) splits.push(g.meshId);
    if (deadSplit) deadSplits.push(g.meshId);
    if (mixedSplit) mixedSplits.push(g.meshId);
    meshTargets.push({
      meshId: g.meshId, resolvesTo: target ? target.id : null, ids: g.ids,
      liveRows: g.liveRows, split, deadSplit, mixedSplit, kind,
    });
  }
  const workspaces = sum.workspaces || {};
  // `live` derivation (FIX: was a bare isLiveSessionId(sessionId) string test —
  // see the header comment at ~line 199 and companion/lib/liveness.js's own
  // header for the two symptoms this closes). Now heartbeat/staleness-aware,
  // wired to the EXISTING liveness module (hasFreshHeartbeat / isDormantRow)
  // rather than inventing a new mechanism:
  //   1. a FRESH heartbeat is definitive proof-of-life (liveness.js header:
  //      "emitted ONLY by the workspace's OWN live session") -> live, even if
  //      sessionId is null/absent OR `unclaimed:`-prefixed (closes the
  //      false-negative symptom: only hooks/devswarm-child-turn.js ever
  //      stamps a real sessionId; other paths write null or a synthetic
  //      `unclaimed:` marker, and a fresh heartbeat is a STRONGER, orthogonal
  //      signal than that marker — the marker exists to stop ROUTING into a
  //      partition nothing drains, not to assert the process is dead).
  //   2. `unclaimed:`-prefixed sessionId with NO fresh heartbeat -> ALWAYS
  //      not-live (the phantom-row case: a registry row with no process and
  //      no real sessionId ever stamped).
  //   3. else, a real (non-synthetic) sessionId with NO stale-past-threshold
  //      activity (isDormantRow — the SAME read-side dormancy rule rosterHints
  //      already uses) -> live. A real sessionId whose heartbeat/activity has
  //      gone stale past the dormancy window is NOT live (closes the
  //      false-positive symptom: closing a workspace leaves its registry row
  //      untouched, so a once-real sessionId used to be trusted forever).
  //   4. no real sessionId and no fresh heartbeat -> not live (unchanged from
  //      before for this shape).
  // NOTE: this heartbeat rescue is DISPLAY-ONLY (rows[].live). Routing/fold
  // signals (liveRows/kind/split/deadSplit in groupRegistryByMeshId, ~line
  // 1795) use isLiveSessionId(sessionId) directly and still treat
  // `unclaimed:` as unconditionally not-live — unaffected by this block.
  // isDormantRow is itself fail-open (no signal at all -> not dormant, per its
  // own doc), so a row with NO heartbeat/transcript signal at all (e.g. a
  // freshly-seeded row in a test, or a workspace never yet heartbeat-capable)
  // degrades to the SAME "live" verdict the old bare-sessionId test gave it —
  // an honest "unknown -> not newly downgraded" default, not a guess in
  // either direction. try/catch keeps this fail-open against any throw from a
  // malformed row, falling back to the OLD bare-sessionId signal so a bug in
  // the liveness read path can never make computeDiagnosis itself throw.
  // DESCRIPTOR/REGISTRY DIVERGENCE FIX (defect 2c4ae6576fab): promoteUnclaimedSession
  // writes the descriptor FIRST, then the registry (~:4529-4541) — the registry
  // write is wrapped in a swallowing try/catch ("descriptor already promoted;
  // registry retries next call"), so a registry write that fails (or is simply
  // never retried, e.g. no later read of that id) leaves the registry's
  // sessionId stuck at the `unclaimed:<id>` marker even after the descriptor has
  // genuinely been promoted to a real session id. `rows` used to read ONLY the
  // registry row (s.listRegistry()), so a row in exactly this state displayed the
  // STALE marker and `live:false` even though workspaces/<id>.json already held
  // the true identity — VERIFIED reproducible: seed a descriptor with a real
  // sessionId and a registry row for the SAME id still carrying the `unclaimed:`
  // marker; pre-fix diagnose printed the marker and live:false for it. Resolve
  // through the descriptor whenever the registry's own sessionId is absent or
  // still synthetic AND the descriptor holds a genuine (non-empty, non-
  // tautological, non-`unclaimed:`) id — the same definition of "real" used by
  // realSessionIdFrom (~:4508). The reverse shape (registry already ahead of the
  // descriptor) already read correctly, since the registry was read directly;
  // that path is unchanged — this only widens what `sid` can resolve to. When the
  // descriptor and registry disagree, `descriptorSessionId` carries the raw
  // descriptor value alongside the resolved `sessionId`, rather than silently
  // dropping the stale value on the floor.
  const isRealSid = (v, id) => (
    v != null && String(v).trim() !== ''
    && String(v) !== String(id)
    && !String(v).startsWith(SYNTHETIC_SESSION_PREFIX)
  );
  const rows = registry.filter((d) => d && d.id != null).map((d) => {
    const w = workspaces[d.id] || {};
    const registrySid = d.sessionId || null;
    let descriptorSid = null;
    try {
      const desc = readDescriptorFile(c.home, d.id);
      descriptorSid = desc && desc.sessionId != null ? String(desc.sessionId) : null;
    } catch (_) { descriptorSid = null; }
    let sid = registrySid;
    if (!isRealSid(registrySid, d.id) && isRealSid(descriptorSid, d.id)) sid = descriptorSid;
    let live = false;
    try {
      if (hasFreshHeartbeat(d.id, c.home, { now: c.now })) {
        live = true;
      } else if (isLiveSessionId(sid)) {
        live = !isDormantRow({ id: d.id, worktreePath: d.worktreePath, sessionId: sid }, c.home, { now: c.now });
      }
    } catch (_) { live = isLiveSessionId(sid); }
    const row = {
      id: d.id,
      worktreePath: d.worktreePath || null,
      sessionId: sid,
      live,
      unread: Number.isFinite(w.unread) ? w.unread : 0,
    };
    if (descriptorSid != null && descriptorSid !== registrySid) row.descriptorSessionId = descriptorSid;
    return row;
  });
  const phantoms = rows.filter((r) => !r.live).length;
  let unreadTotal = 0;
  for (const id of Object.keys(workspaces)) {
    const w = workspaces[id];
    if (w && Number.isFinite(w.directUnread)) unreadTotal += w.directUnread;
  }
  return {
    sum, registry: rows, meshTargets, splits, deadSplits, mixedSplits,
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
  // SURFACING FIX (field defect c55896250399): computeDiagnosis already
  // classifies the exactly-1-live case correctly (`kind:'mixed'`,
  // `mixedSplits` populated — verified: mixedSplits[] carries the meshId for
  // a 2-row/1-live group exactly like deadSplits/splits do for their kinds).
  // The gap was never the classification, it was that `diagnose` — unlike
  // `healthcheck` — had NO explicit call-out: its JSON is a flat dump with no
  // `warning`/`degraded` field, so a caller who checks only the benign
  // `splits` array (which correctly stays [] for the mixed/dead kinds — that
  // field's meaning is "2+ LIVE rows", unchanged) sees nothing and concludes
  // "no split", even though `mixedSplits`/`deadSplits` already carried it.
  // Reporting-only: adds two NEW fields, touches no existing key, and drives
  // no fold/retire/adopt/tombstone decision.
  const dangerCount = d.deadSplits.length + d.mixedSplits.length;
  const degraded = dangerCount > 0 || d.splits.length > 0;
  let warning = null;
  if (d.deadSplits.length > 0) {
    warning = d.deadSplits.length + ' dead split(s) (2+ registry rows, no live session draining either — mail can strand)';
  }
  if (d.mixedSplits.length > 0) {
    const mixedMsg = d.mixedSplits.length + ' mixed split(s) (2+ registry rows, exactly 1 live — a send can still resolve to the dead row)';
    warning = warning ? warning + '; ' + mixedMsg : mixedMsg;
  }
  return {
    ok: true, action: 'diagnose', repoKey,
    count: d.registry.length, registry: d.registry,
    meshTargets: d.meshTargets, splits: d.splits, deadSplits: d.deadSplits, mixedSplits: d.mixedSplits,
    orphans: d.orphans,
    staleRegistryPartitions: d.staleRegistryPartitions,
    degraded, warning,
  };
}

// diagnoseHumanLine(result) — the DEFAULT (non-`--json`) render of `diagnose`,
// giving it the same explicit-WARNING human summary `healthcheck` already has
// (healthcheckHumanLine above) instead of leaving callers to notice
// deadSplits/mixedSplits buried in a raw JSON dump.
function diagnoseHumanLine(r) {
  if (!r || typeof r !== 'object') return String(r);
  if (r.reason === 'no-project') return 'diagnose: no-project (cwd is not inside a DevSwarm project)';
  const parts = [
    'registry=' + (r.count || 0),
    'splits=' + (r.splits ? r.splits.length : 0),
    'deadSplits=' + (r.deadSplits ? r.deadSplits.length : 0),
    'mixedSplits=' + (r.mixedSplits ? r.mixedSplits.length : 0),
    'orphans=' + (r.orphans ? r.orphans.length : 0),
    'stale=' + (r.staleRegistryPartitions ? r.staleRegistryPartitions.length : 0),
  ];
  const scope = r.repoKey ? ' (scope: ' + r.repoKey + ')' : '';
  const status = r.degraded ? 'degraded' : 'ok';
  const warning = r.warning ? ' — WARNING: ' + r.warning : '';
  return 'diagnose: ' + status + scope + ' [' + parts.join(' ') + ']' + warning;
}

// cmdHealthcheck(flags, ctx) — #71: a scriptable PASS/FAIL gate over the SAME data
// `diagnose` computes (computeDiagnosis — one source, two presentations). Unlike
// `diagnose` (always ok:true — a report), this turns mesh-shape drift into an exit
// signal: ok/exit 0 when healthy, ok:false/exit non-zero when degraded.
//   counts = { orphansWithUnread, stale, splits, phantoms, unreadTotal }, plus an
//   `orphans` alias (same value as orphansWithUnread — see rename note below).
//   degraded iff orphansWithUnread>0 || stale>0 || splits>0 (STRUCTURAL drift
//   only) — phantoms (a spawn-time placeholder, benign/transient) and
//   unreadTotal (normal mailbox backlog) are reported for visibility but NEVER
//   gate, so a freshly-spawned worktree does not trip a false "degraded". Pure
//   read (zero writes).
//
// FIX C rename: this count is d.orphans.length from computeDiagnosis/
// computeSummary's A2 detector, which is ALREADY filtered to unread>0 (real
// unread only — see computeSummary's orphans[] comment). It is scope-DIFFERENT
// from healOrphanPartitionsAllStores' `orphans`-shaped counters (heal sweeps
// EVERY store on the machine and counts every orphan regardless of unread;
// this opens only the cwd's ONE store and counts only unread>0 ones) — the two
// surfaces were measured printing 123 vs 0 for the SAME machine under the SAME
// label ("orphans"), which reads as a contradiction. Renaming to
// `orphansWithUnread` here names what this counter ACTUALLY measures; `orphans`
// is kept as an exact-value alias since it is part of this command's existing
// documented JSON contract (no known internal consumer greps `.counts.orphans`
// outside this file/its tests, but an external script might).
function cmdHealthcheck(flags, ctx) {
  const home = ctx.home;
  const cwd = ctx.cwd || process.cwd();
  const repoKey = repokey.repoKeyForWorktree(cwd);
  if (!repoKey) return { ok: false, reason: 'no-project' };
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let d;
  try { d = computeDiagnosis(s, { home, env: ctx.env, now: ctx.now }); } finally { s.close(); }
  const orphansWithUnread = d.orphans.length;
  const counts = {
    orphansWithUnread,
    orphans: orphansWithUnread, // alias — see rename note above
    stale: d.staleRegistryPartitions.length,
    splits: d.splits.length,
    deadSplits: d.deadSplits.length, // HAZARD 2 fix: 2+ rows, ZERO live — dangerous, gates degraded too
    // TRACED P0 fix: exactly 1 live row of 2+ — previously invisible (matched
    // neither `splits` nor `deadSplits`); gates degraded too, since a second
    // send can still resolve to the dead partition and strand.
    mixedSplits: d.mixedSplits.length,
    phantoms: d.phantoms,
    unreadTotal: d.unreadTotal,
  };
  const degraded = counts.orphansWithUnread > 0 || counts.stale > 0 || counts.splits > 0
    || counts.deadSplits > 0 || counts.mixedSplits > 0;
  return {
    ok: !degraded, action: 'healthcheck', repoKey,
    status: degraded ? 'degraded' : 'ok',
    counts,
    detail: {
      orphans: d.orphans,
      staleRegistryPartitions: d.staleRegistryPartitions,
      splits: d.splits,
      deadSplits: d.deadSplits,
      mixedSplits: d.mixedSplits,
    },
  };
}

// healthcheckHumanLine(result) — the DEFAULT (non-`--json`) render of `healthcheck`:
// one compact line. `--json` prints the raw JSON object (main() decides which).
// Carries the `(scope: <repoKey>)` marker (FIX C) so `orphansWithUnread=0` never
// reads as a global all-clear it never was — this checks ONLY the cwd's own store,
// unlike healOrphanPartitionsAllStores' cross-machine sweep.
function healthcheckHumanLine(r) {
  if (!r || typeof r !== 'object') return String(r);
  if (r.reason === 'no-project') return 'healthcheck: no-project (cwd is not inside a DevSwarm project)';
  const c = r.counts || {};
  const orphansWithUnread = c.orphansWithUnread != null ? c.orphansWithUnread : c.orphans;
  const deadSplits = c.deadSplits || 0;
  const mixedSplits = c.mixedSplits || 0;
  const parts = [
    'orphansWithUnread=' + (orphansWithUnread || 0),
    'stale=' + (c.stale || 0),
    'splits=' + (c.splits || 0),
    'deadSplits=' + deadSplits,
    'mixedSplits=' + mixedSplits,
    'phantoms=' + (c.phantoms || 0),
    'unread=' + (c.unreadTotal || 0),
  ];
  const scope = r.repoKey ? ' (scope: ' + r.repoKey + ')' : '';
  // deadSplits (2+ registry rows, ZERO live) is the DANGEROUS kind (HAZARD 2:
  // stranded mail, nobody draining) — surfaced with its own explicit warning
  // suffix so it never blends into the same-looking benign `splits=` count.
  // mixedSplits (exactly 1 live of 2+ rows, TRACED P0) is ALSO dangerous — a
  // second send can still resolve to the dead partition — surfaced the same way.
  let warning = deadSplits > 0
    ? ' — WARNING: ' + deadSplits + ' dead split(s) (2+ registry rows, no live session draining either — mail can strand)'
    : '';
  if (mixedSplits > 0) {
    warning += ' — WARNING: ' + mixedSplits + ' mixed split(s) (2+ registry rows, exactly 1 live — a send can still resolve to the dead row)';
  }
  return 'healthcheck: ' + (r.status || (r.ok ? 'ok' : 'degraded')) + scope + ' [' + parts.join(' ') + ']' + warning;
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
    const ownEntry = resolveMeshTarget(s, from, home);
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
// Defect-2 fix (root cause, VERIFIED via isolated repro): when `d.worktreePath`
// does not exist on disk, `spawnSync(..., { cwd: d.worktreePath })`'s internal
// chdir failure is misreported by Node/libuv as an ENOENT against the SPAWNED
// EXECUTABLE (`process.execPath`) — not against the missing cwd — which reads
// exactly like "node itself is missing" even though node is perfectly present.
// Check existsSync(d.worktreePath) FIRST and short-circuit with a distinct,
// self-describing `worktreeMissing:true` result instead of ever letting that
// misleading spawn failure occur. Detect-only: never deletes/unlinks/moves
// anything — the descriptor and any archived/ counterpart are left untouched.
function defaultSpawnReconcile(d, ctx) {
  let worktreeExists = true;
  try { worktreeExists = fs.existsSync(d.worktreePath); } catch (_) { worktreeExists = true; }
  if (!worktreeExists) {
    return { worktreeMissing: true, error: new Error('worktree not found on disk: ' + d.worktreePath) };
  }
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

// reconcileResumePath(home) -> path to the additive, fail-open, overwritten-
// each-run resume marker (Wave D9). Single home-scoped file (not per-repoKey):
// reconcile is a manual/update-driven sweep, never concurrent with itself for
// the same project, and the marker's own `repoKey` field guards a later run
// for a DIFFERENT project from ever reusing a foreign deferred-id list.
function reconcileResumePath(home) {
  return path.join(home, '.anti-hall', 'devswarm', 'reconcile-resume.json');
}

// readReconcileResume(home, repoKey) -> string[] deferred ids from the last
// run that hit its budget for THIS SAME repoKey, or [] on any absence/parse
// failure/repoKey mismatch (fail-open: a corrupt/foreign marker never blocks
// or crashes reconcile — it just means nothing is prioritized this run).
function readReconcileResume(home, repoKey) {
  try {
    const raw = fs.readFileSync(reconcileResumePath(home), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.repoKey === repoKey && Array.isArray(parsed.ids)) {
      return parsed.ids.filter((x) => typeof x === 'string');
    }
  } catch (_) { /* fail-open: no resume marker */ }
  return [];
}

// writeReconcileResume(home, repoKey, ids) -> void. Overwrites the marker with
// the current run's still-deferred ids (or removes it once nothing is left
// deferred, so a fully-drained sweep doesn't leave a stale marker around).
// Fail-open: a write failure never affects reconcile's own result.
function writeReconcileResume(home, repoKey, ids) {
  try {
    const p = reconcileResumePath(home);
    if (!ids || ids.length === 0) {
      try { fs.unlinkSync(p); } catch (_) { /* already absent — fine */ }
      return;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ repoKey, ids, ts: Date.now() }));
  } catch (_) { /* fail-open: resume marker is best-effort */ }
}

// DEFAULT_RECONCILE_BUDGET_MS — Wave D9 root cause (defect f3c1bc827d89):
// cmdReconcile previously spawned one serial 30s-timeout child PER registry
// row with no total budget/cap, so a project with dozens of stale rows made
// `update.js` (which awaits reconcile synchronously, ~update.js:2160) hang for
// minutes with zero progress output. A total wall-clock budget bounds a single
// sweep's worst case; anything left over is deferred to the NEXT sweep via the
// resume marker above rather than ever blocking the caller indefinitely.
// env `ANTIHALL_RECONCILE_BUDGET_MS` overrides; 0 = unlimited (opt-out).
const DEFAULT_RECONCILE_BUDGET_MS = 60000;

// resolveReconcileClock(ctx) -> () => ms. An injectable clock for cmdReconcile's
// OWN wall-clock budget accounting only — deliberately a SEPARATE ctx field
// from `ctx.now` (used elsewhere in this file, e.g. names.writeName's
// timestamp arg a few hundred lines down in this same function, as a single
// STATIC snapshot number via `Number.isFinite(ctx.now) ? ctx.now : Date.now()`).
// That static-snapshot convention doesn't fit here: the budget loop below
// samples "now" repeatedly across an unbounded number of spawnFn calls, and a
// test double needs to advance a FAKE clock between those samples (so "a
// budget that allows exactly 2 children" is exact by construction, not a race
// against real elapsed wall-clock time on a contended CI runner). Naming this
// `ctx.reconcileNow` (a function) rather than reusing `ctx.now` (a number)
// avoids colliding with that other convention in the same ctx object. Default
// (no injection) is plain `Date.now`, so real behavior is unchanged.
function resolveReconcileClock(ctx) {
  return (ctx && typeof ctx.reconcileNow === 'function') ? ctx.reconcileNow : Date.now;
}

function resolveReconcileBudgetMs(flags, ctx) {
  // update.js (or any caller) may pass its own budget straight through via
  // ctx.reconcileBudgetMs — the cleanest carrier for a value that is never a
  // user-typed CLI flag on THAT call site (update.js invokes `devswarm.run(['reconcile'], ctx)`
  // directly, not via a shell argv). The CLI's own `--budget-ms` flag is for a
  // human/script invoking `devswarm.js reconcile` directly.
  const candidates = [
    ctx && ctx.reconcileBudgetMs,
    one(flags, 'budget-ms'),
    ctx && ctx.env && ctx.env.ANTIHALL_RECONCILE_BUDGET_MS,
  ];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_RECONCILE_BUDGET_MS;
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
//
// Wave D9 additions (budget + resume, root-caused via defect f3c1bc827d89):
// a total wall-clock budget bounds how long one sweep can spend spawning
// per-row children; whatever is left when the budget runs out is deferred to
// `reconcile-resume.json` and prioritized FIRST on the next run (rotation).
// A row whose worktreePath no longer exists on disk is skipped BEFORE it ever
// reaches spawnFn (not just inside defaultSpawnReconcile's own existsSync
// check) so it costs zero budget — but ONLY when spawnFn is the real
// defaultSpawnReconcile: an injected `ctx.io.spawnReconcile` test double is a
// real spawn stand-in and is deliberately never subject to this fs check
// (same posture defaultSpawnReconcile's own doc comment already documents).
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

  let targets = descriptors.filter((d) => d && d.worktreePath && isSafeId(d.id));

  // Resume rotation: prioritize ids deferred by a PRIOR budget-exhausted run
  // (for this same repoKey) so a persistently-large backlog eventually drains
  // in FIFO order across runs rather than the same early rows starving the
  // tail forever. Fail-open (readReconcileResume already tolerates absence).
  const resumeIds = readReconcileResume(home, repoKey);
  if (resumeIds.length > 0) {
    const byId = new Map(targets.map((d) => [d.id, d]));
    const prioritized = [];
    for (const id of resumeIds) {
      const d = byId.get(id);
      if (d) { prioritized.push(d); byId.delete(id); }
    }
    targets = prioritized.concat(Array.from(byId.values()));
  }

  const spawnFn = (ctx.io && ctx.io.spawnReconcile) || defaultSpawnReconcile;
  const usingDefaultSpawn = spawnFn === defaultSpawnReconcile;
  const budgetMs = resolveReconcileBudgetMs(flags, ctx);
  const clockNow = resolveReconcileClock(ctx);
  const startedAt = clockNow();
  let skippedMissingWorktree = 0;
  let processed = 0;
  const deferredIds = [];
  const results = [];
  for (const d of targets) {
    // Pre-spawn missing-worktree skip (defaultSpawnReconcile only — see doc
    // comment above): costs zero budget, unlike letting spawnFn discover it
    // via its own internal existsSync check after a budget slot is already
    // spent deciding to spawn.
    if (usingDefaultSpawn) {
      let exists = true;
      try { exists = fs.existsSync(d.worktreePath); } catch (_) { exists = true; }
      if (!exists) {
        skippedMissingWorktree++;
        results.push({
          id: d.id, worktreePath: d.worktreePath, ok: false, imported: 0, duplicate: 0,
          nativeCount: 0, lost: 0, locked: false, hivecontrolMissing: false,
          worktreeMissing: true,
          archivedDuplicate: hasArchivedCounterpart(home, d.id),
          error: 'worktree not found on disk: ' + d.worktreePath,
        });
        continue;
      }
    }
    // Budget check: only once we're about to actually spawn a child. A budget
    // of 0 means unlimited (never defers).
    if (budgetMs > 0 && (clockNow() - startedAt) >= budgetMs) {
      deferredIds.push(d.id);
      continue;
    }
    processed++;
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
      // Defect-2 fix (root cause): when `d.worktreePath` does not exist on
      // disk, spawnSync's `cwd` chdir failure is misreported by Node/libuv as
      // an ENOENT against the SPAWNED EXECUTABLE (process.execPath) — not
      // against the cwd — which reads exactly like "node is missing" even
      // though node is fine (reproduced in isolation). defaultSpawnReconcile
      // now checks existsSync(d.worktreePath) itself, BEFORE spawning, and
      // sets `worktreeMissing:true` on its return value when the worktree is
      // gone — that is what this reads. A fourth RECOGNIZED BENIGN SKIP, same
      // posture as `locked`/`hivecontrolMissing`. Detect-only: nothing is
      // deleted/unlinked/moved. Deliberately gated to `spawnFn === defaultSpawnReconcile`'s
      // own contract (injected `ctx.io.spawnReconcile` test doubles are real
      // spawn stand-ins and are never subject to this fs check).
      worktreeMissing: !!(r && r.worktreeMissing),
      archivedDuplicate: !!(r && r.worktreeMissing && hasArchivedCounterpart(home, d.id)),
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
  // Defect-2 fix: `worktreeMissing:true` is a FOURTH recognized benign skip —
  // set only by the pre-spawn existsSync check above, never by parsing an
  // error string, so it cannot be spoofed by a subprocess's stdout the way an
  // allow-listed regex could be.
  const allRowsOkOrBenign = results.every((r) => r.ok === true || r.locked === true || r.hivecontrolMissing === true || r.worktreeMissing === true);

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

  // Wave D9: persist whatever is still deferred so the NEXT sweep (for this
  // same repoKey) prioritizes it first (rotation) — writeReconcileResume
  // itself removes the marker entirely when deferredIds is empty, so a fully-
  // drained sweep never leaves a stale file behind.
  writeReconcileResume(home, repoKey, deferredIds);

  const out = {
    ok: allRowsOkOrBenign, action: 'reconcile', repoKey,
    count: results.length, imported, lost, rejected, results,
    budgetMs, processed, skippedMissingWorktree, deferred: deferredIds.length,
    elapsedMs: clockNow() - startedAt,
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
// SPAWN LAUNCH VERIFICATION (defect f85dedeaf61f, anti-hall half).
//
// FIELD SHAPE: `hivecontrol workspace create` returned success, this verb
// blind-seeded a registry row (sessionId null, inboxPath null) and returned
// `ok:true, created:true, registered:true` — and NO session ever started. The
// row read ACTIVE in the roster for 25 minutes, working_on null, the worktree's
// own inbox and heartbeat log both 0 bytes, a Primary's message to it unread the
// whole time. WHY the launch failed is UNKNOWN and external (the reporter tested
// and REFUTED the obvious self-collision hypothesis); this fix does not touch it.
//
// WHAT WAS WRONG ON OUR SIDE: the return conflated CREATE with LAUNCH. The
// create success schema carries NO session field (verified: resolveCreatedWorktreePath
// parses a path only), so `created:true` was never evidence a child was running,
// yet the response offered nothing else to read. `launched` now reports that
// separately, from POSITIVE EVIDENCE ONLY.
//
// EVIDENCE (any one is proof-of-launch — all three are written by the CHILD's own
// session, never by this verb): a fresh heartbeat for the mesh id; a registry row
// whose sessionId/inboxPath the child filled in over our null seed; or the child's
// own descriptor file.
//
// `launched` IS TRI-STATE AND NEVER `false`: absence of a heartbeat inside a short
// window is NOT proof the child failed to launch — a real session can take far
// longer than any window this verb may block for. Reporting `false` there would be
// the same class of unearned claim as the `created:true`-implies-launched this
// fixes. So: `true` (evidence seen) or `'unknown'` (none yet, verdict open), with
// `launchHint` naming the verb that settles it later. On the default window
// `'unknown'` is the EXPECTED outcome for a healthy spawn — it means "not yet
// confirmed", not "broken".
//
// NEVER BLOCKS LONG and NEVER FAILS THE VERB: default 750ms, overridable via
// ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS (0 = one immediate check, no sleep), and
// the poll returns the instant evidence appears. Any throw inside it yields
// 'unknown', exactly like a clean timeout.
const SPAWN_LAUNCH_WAIT_MS_DEFAULT = 750;
// SPAWN_LAUNCH_WAIT_MAX_MS — hard ceiling on how long `spawn` may block for
// launch evidence. `checkSpawnLaunch`'s poll is SYNCHRONOUS (Atomics.wait), so
// the configured window is wall-clock time the whole CLI is frozen with no
// output and no way to interrupt it: `ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS=
// 999999999` wedged `spawn` for eleven and a half days. The verdict this poll
// produces is explicitly best-effort ('unknown' is never a failure, and the
// hint already tells the caller to re-check with `roster`/`heartbeat` in a
// minute), so no legitimate use is served by waiting longer than a few
// seconds. 10s is generous against a normal launch and still bounded.
const SPAWN_LAUNCH_WAIT_MAX_MS = 10000;

// spawnLaunchWaitRequestedMs(env) -> the UNCLAMPED configured window (the
// pre-clamp behaviour), kept separate so checkSpawnLaunch can report WHETHER a
// clamp was applied rather than silently honouring a different number than the
// operator asked for.
function spawnLaunchWaitRequestedMs(env) {
  const raw = env ? env.ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') return SPAWN_LAUNCH_WAIT_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SPAWN_LAUNCH_WAIT_MS_DEFAULT; // a bad value falls back to the default, never disables the check silently
  return Math.floor(n);
}
function spawnLaunchWaitMs(env) {
  return Math.min(spawnLaunchWaitRequestedMs(env), SPAWN_LAUNCH_WAIT_MAX_MS);
}
// checkSpawnLaunch(meshId, ctx, storeOpen) -> {launched, evidence, waitedMs, windowMs}
// storeOpen() -> a fresh store handle | null (injected so the poll re-reads the
// registry rather than trusting the handle the seed write already closed).
// `opts.since` (ms) — the RECENCY FLOOR. Evidence only counts as proof that
// THIS spawn launched something if it was produced AT OR AFTER the given
// instant (inclusive: a beat written in the same millisecond the spawn started
// is genuinely new, and ms resolution is far too coarse to spend a boundary on
// when the hazard being excluded is measured in MINUTES);
// cmdSpawn passes the wall-clock it captured BEFORE the hivecontrol `create`
// call, so anything predating the spawn is ignored.
//
// ROOT CAUSE this closes: `hasFreshHeartbeat` accepts any beat inside its
// 15-minute freshness window, and a meshId is derived from the WORKTREE PATH —
// so re-spawning a branch onto a path a prior occupant used (branch reuse)
// found that occupant's minutes-old heartbeat sitting there and reported
// `launched:true, launchEvidence:'heartbeat', launchCheckedMs:0` having
// observed nothing new whatsoever. The same applies to a stale registry row
// and a leftover descriptor file. `since` makes every signal answer "did this
// appear because of THIS spawn", which is the question the field actually asks.
//
// BACK-COMPAT: `since` absent/non-finite = no floor, i.e. exactly the previous
// predicate. Direct callers that assert on the predicate itself (rather than
// through cmdSpawn) are unaffected; production always passes it.
function checkSpawnLaunch(meshId, ctx, storeOpen, opts) {
  const requestedMs = spawnLaunchWaitRequestedMs(ctx && ctx.env);
  const windowMs = spawnLaunchWaitMs(ctx && ctx.env);
  const windowClamped = requestedMs > windowMs;
  const since = opts && Number.isFinite(opts.since) ? opts.since : null;
  const started = Date.now();
  const stepMs = 150;
  // A8 — ONE store handle for the WHOLE poll, not one per 150ms iteration.
  // `storeOpen()` runs mkdir + PRAGMAs + `CREATE TABLE IF NOT EXISTS` on every
  // call, so a 10s window paid ~66 full store initialisations to answer one
  // question. Hoisting is safe for freshness (the property the injected
  // `storeOpen` exists to guarantee): BOTH backends re-read their source on
  // every `listRegistry()` call — sqlite issues a fresh `SELECT * FROM
  // registry`, the journal backend re-reduces its append-only log off disk —
  // so a held handle observes the child's registration exactly as a reopened
  // one would. Fail-soft is preserved in both directions: a throwing
  // `storeOpen` leaves `handle` null and the registry signal simply yields no
  // evidence, and the handle is closed in the `finally` below even if the poll
  // returns early or throws.
  let handle = null;
  let handleTried = false;
  const registryHandle = () => {
    if (!handleTried) {
      handleTried = true;
      try { handle = storeOpen(); } catch (_) { handle = null; }
    }
    return handle;
  };
  // fileNewerThan(p) -> true when p's mtime postdates `since` (always true when
  // there is no floor). Used for the descriptor signal, whose only timestamp is
  // its file mtime.
  const fileNewerThan = (p) => {
    if (since === null) return true;
    try { return fs.statSync(p).mtimeMs >= since; } catch (_) { return false; }
  };
  const evidenceNow = () => {
    try {
      if (since === null) {
        if (hasFreshHeartbeat(meshId, ctx.home, {})) return 'heartbeat';
      } else {
        // Compare the beat's OWN timestamp against the floor rather than
        // asking hasFreshHeartbeat, whose 15-minute window is exactly what
        // let a prior occupant's beat through.
        const ts = heartbeatTs(meshId, ctx.home);
        if (Number.isFinite(ts) && ts >= since) return 'heartbeat';
      }
    } catch (_) { /* no evidence from this signal */ }
    try {
      const s = registryHandle();
      if (s) {
        const row = (s.listRegistry() || []).find((r) => r && String(r.id) === String(meshId));
        // The seed wrote sessionId/inboxPath as null; ONLY the child's own
        // register can make either non-null, so either is positive evidence.
        // With a floor, ALSO require the row's own last-upsert time to
        // postdate it — otherwise a prior occupant's row (non-null sessionId,
        // written long before this spawn) reads as a launch. `updatedAt` null
        // (a pre-migration row never re-upserted) cannot clear the floor and
        // is treated as no evidence, the conservative direction: 'unknown' is
        // never a hard failure, a false 'launched:true' is.
        const rowFresh = (r) => since === null || (r && Number.isFinite(r.updatedAt) && r.updatedAt >= since);
        if (row && rowFresh(row)) {
          if (row.sessionId != null && String(row.sessionId) !== '') return 'registry-session';
          if (row.inboxPath != null && String(row.inboxPath) !== '') return 'registry-inbox';
        }
      }
    } catch (_) { /* no evidence from this signal */ }
    try {
      if (readDescriptorFile(ctx.home, meshId) && fileNewerThan(descriptorPath(ctx.home, meshId))) return 'descriptor';
    } catch (_) { /* no evidence from this signal */ }
    return null;
  };
  const verdict = (launched, evidence) => {
    const out = { launched, evidence, waitedMs: Date.now() - started, windowMs };
    // Never silently honour a different number than the operator configured.
    if (windowClamped) { out.launchWindowClamped = true; out.launchWindowRequestedMs = requestedMs; }
    return out;
  };
  try {
    for (;;) {
      const ev = evidenceNow();
      if (ev) return verdict(true, ev);
      if (Date.now() - started >= windowMs) break;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs); } catch (_) { break; }
    }
    return verdict('unknown', null);
  } finally {
    if (handle) { try { handle.close(); } catch (_) { /* best-effort */ } }
  }
}

// ===== reap-orphans (defect b712da3bf077, P1) ==============================
// reapedDir(home) — where a reap's loss-free archive of a partition's unread
// rows lands, one NDJSON file per partition.
function reapedDir(home) { return path.join(devswarmRoot(home), 'reaped'); }

// collectOrphanCandidates(ctx) -> { ok, candidates[], repoKey } — the mesh
// partitions with unread mail and NO live reader.
//
// REUSES the EXISTING detector rather than re-deriving it: this is exactly the
// set devswarm-store.js's computeSummary A2 pass publishes as `summary.orphans`
// (`listWorkspaceIds() − registry ids − broadcast`, filtered to real unread,
// minus the archived-stranded and forwarded-drained classes), and it is the
// SAME array hooks/devswarm-parent-inbox.js renders as the per-turn "⚠ DEVSWARM
// ORPHANED MESH: N partition(s) with unread but no live workspace to read them"
// warning. Reaping something the warning does not report — or failing to reap
// something it does — is the drift this reuse exists to make impossible.
// computeSummary is the PURE half (zero writes), which is what a dry-run-first
// verb must call.
function collectOrphanCandidates(ctx) {
  const home = ctx.home;
  const repoKey = repoKeyForCwd(ctx);
  if (!repoKey) return { ok: false, reason: 'no-project', error: 'reap-orphans must run inside a git worktree (the mesh store is per-project)' };
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  try {
    const sum = store.computeSummary(s, { home, env: ctx.env, now: ctx.now });
    const orphans = Array.isArray(sum && sum.orphans) ? sum.orphans : [];
    const candidates = orphans.filter((o) => o && o.id != null && isSafeId(String(o.id))).map((o) => {
      // lastMessageTs: the newest row actually sitting in the partition, so a
      // human can see whether this is week-old sediment or something that
      // arrived an hour ago before authorising anything.
      let lastMessageTs = null;
      try {
        for (const m of (s.listMessages(String(o.id)) || [])) {
          const t = Number(m && m.ts);
          if (Number.isFinite(t) && (lastMessageTs === null || t > lastMessageTs)) lastMessageTs = t;
        }
      } catch (_) { lastMessageTs = null; }
      return {
        partitionId: String(o.id),
        unread: Number.isFinite(o.unread) ? o.unread : 0,
        messageCount: Number.isFinite(o.messageCount) ? o.messageCount : 0,
        lastMessageTs,
        reason: 'unread-with-no-live-reader',
      };
    });
    return { ok: true, candidates, repoKey };
  } finally { s.close(); }
}

// cmdReapOrphans(flags, ctx) — retire orphaned mesh partitions, SAFELY.
//
// WHAT "REAP" MEANS HERE, stated exactly (this is NOT a row deletion, and the
// difference is deliberate):
//   1. every UNREAD row of the partition is written to
//      <devswarmRoot>/reaped/<partitionId>.ndjson and READ BACK AND VERIFIED
//      line-for-line before anything else happens;
//   2. only then is the partition RETIRED by advancing its cursor to its own
//      message count, which is what removes it from computeSummary's
//      `orphans[]` (that set is gated on `unread > 0`) and therefore silences
//      the per-turn warning.
// The message rows themselves are LEFT INTACT in the store. Two reasons, both
// load-bearing rather than a limitation being dressed up: the store exposes no
// partition-delete primitive at all (there is `removeRegistry`, but an orphan
// by definition HAS no registry row), and this file's whole surrounding posture
// on this data is "surface only: NEVER auto-forwarded or deleted". Retiring
// rather than destroying achieves everything the defect asked for — 65 orphans
// stop nagging, in bulk, without a 20-of-88 partial failure — while keeping the
// mail recoverable from BOTH the store and the archive file. A caller who
// genuinely wants the bytes gone still has the archive plus an intact store to
// do it from, deliberately, by hand.
//
// SAFETY GATES (belt and braces — every one of these is a REFUSAL, not a
// warning, because the failure mode being guarded is "an automated loop
// quietly retires a live Primary's backlog"):
//   * DRY RUN IS THE DEFAULT. Bare `reap-orphans` only ever prints candidates.
//   * `--apply` REQUIRES `--max N`, N a positive integer. No unbounded apply
//     exists at all, so a runaway pass has a hard ceiling the caller chose.
//   * Never acts on more than N candidates, even if more qualify.
//   * REFUSES when ANTIHALL_DEVSWARM_AUTOMATION=1 — the marker a supervisor /
//     cron / hook context sets. Not overridable.
//   * REFUSES when stdin is not a TTY (the shape of a cron job, a pipeline, or
//     a subagent shell) unless `--i-am-a-human` is ALSO passed, which is a
//     claim a scheduled job has no reason to make.
//   * Per-partition, REFUSES to retire if the archive write or its verify
//     read-back fails — loss-free means the copy is PROVEN before the source
//     is touched, never assumed.
function cmdReapOrphans(flags, ctx) {
  const home = ctx.home;
  const apply = !!flags.apply;
  const collected = collectOrphanCandidates(ctx);
  if (!collected.ok) return Object.assign({ ok: false, action: 'reap-orphans' }, collected);
  const candidates = collected.candidates;
  if (!apply) {
    return {
      ok: true, action: 'reap-orphans', mode: 'dry-run', repoKey: collected.repoKey,
      candidateCount: candidates.length, candidates,
      note: candidates.length
        ? 'DRY RUN — nothing was changed. To act, re-run with `--apply --max N` (N = the most partitions '
          + 'this pass may retire). Each retired partition\'s unread rows are archived to '
          + reapedDir(home) + '/<partitionId>.ndjson and verified BEFORE its cursor is advanced; '
          + 'no message row is deleted.'
        : 'no orphaned partitions with unread mail in this project',
    };
  }
  // ---- apply-path refusals (checked BEFORE any work) ----
  const maxRaw = one(flags, 'max');
  if (maxRaw === undefined) {
    return { ok: false, action: 'reap-orphans', reason: 'max-required',
      error: '--apply requires --max N (the maximum number of partitions this pass may retire). '
        + 'There is deliberately no unbounded apply.' };
  }
  const maxN = Number(maxRaw);
  if (!Number.isFinite(maxN) || maxN < 1 || Math.floor(maxN) !== maxN) {
    return { ok: false, action: 'reap-orphans', reason: 'bad-max',
      error: '--max must be a positive integer (got ' + JSON.stringify(String(maxRaw)) + ')' };
  }
  if (ctx.env && String(ctx.env.ANTIHALL_DEVSWARM_AUTOMATION) === '1') {
    return { ok: false, action: 'reap-orphans', reason: 'automation-refused',
      error: 'refusing to --apply with ANTIHALL_DEVSWARM_AUTOMATION=1 set: retiring a partition is a '
        + 'human decision, never a scheduled sweep. Run it yourself from an interactive shell.' };
  }
  const humanClaimed = !!flags['i-am-a-human'];
  const isTty = !!(ctx.stdinIsTty !== undefined ? ctx.stdinIsTty : (process.stdin && process.stdin.isTTY));
  if (!isTty && !humanClaimed) {
    return { ok: false, action: 'reap-orphans', reason: 'non-interactive-refused',
      error: 'refusing to --apply from a non-interactive stdin (cron/pipeline/subagent shape). '
        + 'If a human really is driving this, pass --i-am-a-human as well.' };
  }
  const targets = candidates.slice(0, maxN);
  const repoKey = collected.repoKey;
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  const reaped = [];
  const failed = [];
  try {
    for (const c of targets) {
      const pid = c.partitionId;
      try {
        const cursor = s.cursorValue(pid);
        const total = s.messageCount(pid);
        const unreadRows = (s.listMessages(pid, { sinceCursor: cursor }) || []);
        if (!unreadRows.length) { failed.push({ partitionId: pid, reason: 'no-unread-rows' }); continue; }
        // ---- ARCHIVE, THEN VERIFY, THEN (and only then) RETIRE ----
        fs.mkdirSync(reapedDir(home), { recursive: true });
        const archivePath = path.join(reapedDir(home), pid + '.ndjson');
        const payload = unreadRows.map((m) => JSON.stringify({
          partitionId: pid, reapedAt: new Date().toISOString(), message: m,
        })).join('\n') + '\n';
        fs.writeFileSync(archivePath, payload);
        // VERIFY by reading the file back and counting the rows that actually
        // landed — not by trusting writeFileSync's return. A short write, a
        // full disk, or a truncating filesystem is exactly the case where
        // "assumed archived" would silently become "lost".
        const readBack = fs.readFileSync(archivePath, 'utf8');
        const landed = readBack.split('\n').filter((l) => l.trim() !== '');
        if (landed.length !== unreadRows.length) {
          failed.push({ partitionId: pid, reason: 'archive-verify-failed',
            expected: unreadRows.length, got: landed.length });
          continue; // REFUSE to retire — the source stays exactly as it was
        }
        let parsedOk = true;
        for (const line of landed) { try { JSON.parse(line); } catch (_) { parsedOk = false; break; } }
        if (!parsedOk) {
          failed.push({ partitionId: pid, reason: 'archive-verify-unparseable' });
          continue; // REFUSE to retire
        }
        s.setCursor(pid, total);
        // P0 LOCKSTEP (v0.90.1): keep the read-path ack file in step with the
        // store cursor — see foldOne's own lockstep note. Without it this
        // partition's archived rows stayed "unread" to `read-primary` (which
        // sizes from the json namespace) forever after a reap.
        try { inboxCursor.ackTo(primaryCursorPath(home, pid), total); } catch (_) { /* fail-soft: reconcile re-converges the pair */ }
        reaped.push({ partitionId: pid, unread: unreadRows.length, archivePath, cursorAdvancedTo: total });
      } catch (e) {
        failed.push({ partitionId: pid, reason: 'error', error: String((e && e.message) || e) });
      }
    }
    if (reaped.length) {
      try { store.deriveSummary(s, { home, env: ctx.env, now: ctx.now }); } catch (_) { /* projection refresh is best-effort */ }
    }
  } finally { s.close(); }
  return {
    ok: true, action: 'reap-orphans', mode: 'apply', repoKey,
    max: maxN, candidateCount: candidates.length, consideredCount: targets.length,
    reapedCount: reaped.length, reaped,
    failedCount: failed.length, failed,
    // Never let a capped pass look like a complete one.
    capped: candidates.length > targets.length,
    remaining: candidates.length - targets.length,
    note: 'unread rows were archived + verified under ' + reapedDir(home)
      + ' and each partition retired by advancing its cursor; NO message rows were deleted',
  };
}

// ===== reconcile-registry (defect d9a823ff1ca0, P1) ========================
// REPORT-ONLY, by construction: drift between the mesh registry and hivecontrol
// runs in BOTH directions (a row archived here but still open there; a row
// worktree-gone here but listed active there), and neither side is
// unconditionally authoritative — "fixing" one from the other automatically is
// how a live workspace gets retired from under its owner. This verb therefore
// only ever READS and PRINTS; there is no --apply, deliberately.
//
// SHAPE PINNING: `hivecontrol workspace list all`'s JSON is not pinned in the
// KB, and this file's other consumer (parseChildrenList) is deliberately
// TOLERANT — it normalises every missing field to null. Tolerance is right for
// a best-effort roster fold, but WRONG here: a drift report built from
// all-null records would confidently claim every workspace is missing/
// mismatched, which is worse than no report. So the RAW records are inspected
// for the fields this comparison actually depends on, and an unrecognised
// shape FAILS SOFT with the keys actually seen rather than guessing.
const HIVECONTROL_EXPECTED_FIELDS = ['id', 'path'];
// reconcileRealPath(p) — worktree-path identity, resolved the same way the
// store's own resolveWorktreeReal does (inst.worktreeRealPath, else
// path.resolve). Never throws: an unresolvable path degrades to its literal
// form, so a comparison still happens instead of the report dying.
function reconcileRealPath(p) {
  try {
    if (inst && typeof inst.worktreeRealPath === 'function') return inst.worktreeRealPath(p);
  } catch (_) { /* fall through to a plain resolve */ }
  try { return path.resolve(String(p == null ? '' : p)); } catch (_) { return String(p == null ? '' : p); }
}
function cmdReconcileRegistry(flags, ctx) {
  const home = ctx.home;
  const repoKey = repoKeyForCwd(ctx);
  if (!repoKey) {
    return { ok: false, action: 'reconcile-registry', reason: 'no-project',
      error: 'reconcile-registry must run inside a git worktree (the mesh registry is per-project)' };
  }
  const run = (ctx.io && ctx.io.run) || pull.defaultRun;
  let res;
  try {
    res = run({ args: ['workspace', 'list', 'all'], env: ctx.env, cwd: ctx.cwd || process.cwd(), timeout: LIST_CHILDREN_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, action: 'reconcile-registry', reason: 'hivecontrol-unavailable',
      error: 'hivecontrol workspace list all failed: ' + String((e && e.message) || e) };
  }
  if (!res || !res.ok) {
    return { ok: false, action: 'reconcile-registry', reason: 'hivecontrol-unavailable',
      error: 'hivecontrol workspace list all failed: ' + String((res && res.error) || 'no output') };
  }
  let parsed;
  try { parsed = JSON.parse(res.raw); } catch (_) {
    return { ok: false, action: 'reconcile-registry', reason: 'hivecontrol-shape-unrecognized',
      error: 'hivecontrol workspace list all did not return parseable JSON', rawKeys: [] };
  }
  const rawList = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.children) ? parsed.children : null);
  if (!rawList) {
    return { ok: false, action: 'reconcile-registry', reason: 'hivecontrol-shape-unrecognized',
      error: 'expected an array of workspace records (bare, or under `children`)',
      rawKeys: (parsed && typeof parsed === 'object') ? Object.keys(parsed) : [] };
  }
  const records = rawList.filter((e) => e && typeof e === 'object');
  // An EMPTY list is a legitimate answer (no workspaces), not an unrecognised
  // shape — only a NON-empty list whose records lack the fields this report
  // depends on is a shape failure.
  if (records.length) {
    const seenKeys = Array.from(new Set(records.flatMap((e) => Object.keys(e))));
    const missing = HIVECONTROL_EXPECTED_FIELDS.filter((f) => {
      if (f === 'path') return !seenKeys.includes('path') && !seenKeys.includes('worktreePath');
      return !seenKeys.includes(f);
    });
    if (missing.length) {
      return { ok: false, action: 'reconcile-registry', reason: 'hivecontrol-shape-unrecognized',
        error: 'hivecontrol workspace records are missing expected field(s): ' + missing.join(', ')
          + ' — refusing to guess at the mapping rather than emit a drift report built on assumptions',
        missingFields: missing, rawKeys: seenKeys };
    }
  }
  const hc = parseChildrenList(res.raw).filter((e) => e.id);
  const s = store.openStore({ home, hash: repoKey, backend: ctx.backend, env: ctx.env });
  let registry;
  try { registry = s.listRegistry() || []; } finally { s.close(); }
  const hcById = new Map(hc.map((e) => [String(e.id), e]));
  const regById = new Map(registry.filter((d) => d && d.id != null).map((d) => [String(d.id), d]));
  const registryWithoutWorkspace = [];
  const workspaceWithoutRegistry = [];
  const worktreePathMismatch = [];
  for (const [id, d] of regById) {
    const w = hcById.get(id);
    if (!w) { registryWithoutWorkspace.push({ id, worktreePath: d.worktreePath || null }); continue; }
    const a = d.worktreePath ? String(d.worktreePath) : null;
    const b = w.path ? String(w.path) : null;
    // Compare RESOLVED paths — a symlinked or trailing-slash difference is not
    // real drift and reporting it as such would bury the genuine cases. Uses
    // the SAME worktreeRealPath primitive devswarm-store.js's own
    // resolveWorktreeReal wraps, so the two cannot disagree about identity.
    if (a && b && reconcileRealPath(a) !== reconcileRealPath(b)) {
      worktreePathMismatch.push({ id, registryWorktreePath: a, hivecontrolPath: b });
    }
  }
  for (const [id, w] of hcById) {
    if (!regById.has(id)) workspaceWithoutRegistry.push({ id, path: w.path || null, label: w.label || null });
  }
  const driftCount = registryWithoutWorkspace.length + workspaceWithoutRegistry.length + worktreePathMismatch.length;
  return {
    ok: true, action: 'reconcile-registry', repoKey, reportOnly: true,
    registryCount: regById.size, hivecontrolCount: hcById.size,
    driftCount,
    registryWithoutWorkspace, workspaceWithoutRegistry, worktreePathMismatch,
    note: 'REPORT ONLY — nothing was changed. Drift runs in both directions and neither side is '
      + 'unconditionally authoritative, so reconciling is a human decision made per row.',
  };
}

function cmdSpawn(rest, ctx) {
  const branch = rest && rest[0];
  if (!branch) return { ok: false, error: 'spawn requires a branch name' };
  const cwd = ctx.cwd || process.cwd();
  const run = (ctx.io && ctx.io.run) || pull.defaultRun;
  const args = ['workspace', 'create'].concat(rest);
  // RECENCY FLOOR for the launch check below — captured BEFORE `create` so any
  // evidence produced during the create call still counts, while anything that
  // predates this spawn entirely (a prior occupant of a reused branch/worktree,
  // whose meshId is identical because meshIds derive from the worktree PATH)
  // does not. See checkSpawnLaunch's header.
  const spawnStartedAt = Date.now();
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

  // LAUNCH VERIFICATION — see checkSpawnLaunch's header. Only meaningful once a
  // meshId resolved (no path -> nothing to poll for); best-effort in every
  // direction, and it can never fail the verb or change `created`/`registered`.
  let launch = { launched: 'unknown', evidence: null, waitedMs: 0, windowMs: spawnLaunchWaitMs(ctx.env) };
  if (meshId) {
    try {
      const repoKey = repoKeyForCwd(ctx);
      launch = checkSpawnLaunch(meshId, ctx, () => store.openStore({
        home: ctx.home, hash: repoKey || undefined, backend: ctx.backend, env: ctx.env,
      }), { since: spawnStartedAt });
    } catch (_) { launch = { launched: 'unknown', evidence: null, waitedMs: 0, windowMs: spawnLaunchWaitMs(ctx.env) }; }
  }

  return {
    ok: true, action: 'spawn', branch, created: true,
    worktreePath, meshId, registered, titled,
    // DISTINCT from `created`: the workspace exists, but a session running in it
    // is a separate fact with separate evidence. Never `false` — absence of a
    // signal inside a short window is not proof of failure (see header).
    launched: launch.launched,
    launchEvidence: launch.evidence,
    launchCheckedMs: launch.waitedMs,
    launchWindowMs: launch.windowMs,
    // Present ONLY when the configured window exceeded SPAWN_LAUNCH_WAIT_MAX_MS
    // and was capped — never let the caller believe a longer wait happened.
    launchWindowClamped: launch.launchWindowClamped,
    launchWindowRequestedMs: launch.launchWindowRequestedMs,
    launchHint: launch.launched === true ? undefined
      : 'created, but NO session has registered/heartbeated for ' + String(meshId || branch)
        + ' yet (checked ' + launch.waitedMs + 'ms). This is normal right after a spawn — a launch takes '
        + 'longer than this verb may block for. Confirm with `devswarm roster` or `devswarm heartbeat '
        + String(meshId || '<meshId>') + '` in a minute; a row still showing sessionId null with a 0-byte '
        + 'heartbeat log after several minutes never launched.',
    raw: res.raw,
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
        // read-primary/peek-primary); count/read/ack are the descriptor
        // durable-inbox path.
        if (sub === 'pull' || sub === 'messages' || sub === 'read-primary' || sub === 'peek-primary') {
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
        const rawId = positionals[1];
        if (!isSafeId(rawId)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const resolved = resolveArchiveId(rawId, ctx);
        if (!resolved.ok) return { code: 2, result: Object.assign({ action: 'archive', id: rawId, descriptorArchived: false }, resolved) };
        const r = cmdArchive(resolved.id, ctx, { flags });
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'reap-orphans': {
        const r = cmdReapOrphans(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'reconcile-registry': {
        const r = cmdReconcileRegistry(flags, ctx);
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
      case 'gate-intent': {
        // `gate-intent --reason "<text>" [--session <id>]` — the explicit
        // stated-intent signal devswarm-parent-gate.js's Stop hook consumes.
        // See cmdGateIntent's own header for why this is a CLI verb rather
        // than a transcript-tail keyword scan.
        const r = cmdGateIntent(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      default:
        return { code: 2, result: { ok: false, error: 'unknown command: ' + JSON.stringify(cmd || '') +
          ' (register|register-primary|ensure|heartbeat|inbox|workspaces|gate|gate-intent|nudge|archive|unarchive|archive-ignore|archive-unignore|archive-request|migrate|migrate-owner-keys|logs|send|roster|diagnose|healthcheck|mesh|reconcile|reap-stale|reconcile-active|spawn|merge|skip)' } };
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
  // `healthcheck`/`diagnose` (no --json) print ONE compact human line; every
  // other verb — and either of these WITH --json — prints the raw JSON
  // object. `diagnose` gained a human-line mode alongside healthcheck (field
  // defect c55896250399): a raw JSON dump left a genuinely partitioned mesh's
  // `mixedSplits`/`deadSplits` easy to miss when only the benign `splits`
  // array (correctly empty for those kinds) was eyeballed.
  const wantHuman = (argv[0] === 'healthcheck' || argv[0] === 'diagnose') && !argv.includes('--json');
  const out = wantHuman
    ? (argv[0] === 'healthcheck' ? healthcheckHumanLine(result) : diagnoseHumanLine(result))
    : JSON.stringify(result);
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
  retireWorktreeDuplicates, isLiveSessionId, archiveLeftReason,
  foldGroupIntoSurvivor, canonicalMeshId, canonicalWorktreeRealPath, groupRegistryByMeshId, foldMeshDuplicates,
  fetchActiveWorkspaceRecords,
  foldMeshDuplicatesAllStores,
  healOrphanPartitions, healOrphanPartitionsAllStores,
  retireArchivedWorktreeGroup, foldArchivedRegistryRows, foldArchivedFamilyDescriptors,
  retireIdentityFamilyDescriptors, meshRowCopy, MESH_ROW_COPY_FIELDS, cmdRoster,
  computeDiagnosis, healthcheckHumanLine, diagnoseHumanLine, hasArchivedCounterpart,
  resolveMeshTarget, resolveSendTarget,
  workspacesDir, archivedDir, heartbeatsDir, archiveIgnoreDir, primaryCursorPath, skipFilePath,
  selfHeal, withSelfHeal, SELF_HEAL_COOLDOWN_MS, selfHealCooldownPath,
  migrateOwnerKeys, rehomeCore, rehomeAcrossStores, rehomeMiskeyedRow, healRegistry, withIdLock, cmdArchive, archivedTombstoneIsOrphaned,
  resolveArchiveId,
  applyRecoveryIntents, recoveryIntentPath, rehomeStrandedProjectDescriptors,
  cmdWorkspacesList, cmdGate, cmdReconcile, cmdRegister,
  cmdLogs, cmdInboxMessages, parseSinceDuration,
  descriptorFreshRepoKey, descriptorStructuralRepoKey,
  siblingAckGate, cmdInbox,
  // Exported for direct testing: cmdSpawn's own registry SEED (sessionId null)
  // runs before the poll and overwrites any row already present, so the
  // "child registered during the window" branch is unreachable from a
  // fixture that pre-seeds a sessionId — it has to be exercised against the
  // predicate itself.
  checkSpawnLaunch, spawnLaunchWaitMs, spawnLaunchWaitRequestedMs, SPAWN_LAUNCH_WAIT_MAX_MS,
  cmdReapOrphans, cmdReconcileRegistry, collectOrphanCandidates, reapedDir,
  forceCrossProjectOverride,
  inboxWindowRejection, parseInboxSince,
  // carry-out (e) — `unclaimed:<id>` promotion + its forward migration
  // (called by skills/update/scripts/update.js AND hooks/lib/doctor-repair.js):
  realSessionIdFrom, promoteUnclaimedSession, maybePromoteUnclaimed, callerOwnsRow,
  // defect 54a6539e2d69 — the no-`--session`/no-env parent-pid-chain fallback
  // (exported for direct unit testing with an injected ppidOf/pid/fs):
  deriveCallerSessionIdFromProcessTree, currentRegistrySessionId,
  // v0.90.1 P0 cursor-namespace hotfix (exported for direct unit testing):
  siblingBaseCursor, siblingSeenCursorPath, readSiblingSeenCursor, writeSiblingSeenCursor,
  removeSiblingSeenCursor, parseSiblingSeenCursorName, watermarkSafeId,
  siblingWatermarkCovered,
  // D11-A (TOCTOU fix) — exported for direct unit testing:
  watermarkLockKey, withWatermarkLock,
  broadcastFamilyOwns, ghostRegistryRows, GHOST_ROW_MAX_AGE_H_DEFAULT,
  reconcileOrphanCursor,
  promoteUnclaimedRegistrySessions,
  // defect 64861a623503 — forwarded-copy identity + the fold's dedup seeding:
  foldSiblingGapRows, forwardedOrigHashOf, logicalDeliveryKey,
  stripArchivedForwardPrefix, consumedDedupSeed, CONSUMED_HASH_SEED_CAP,
  forwardArchivedOrphanUnread, archivedForwardProvenancePrefix,
  // v0.90.0 send receipts (writer; the reader is hooks/devswarm-parent-reply-tracker.js):
  writeSendReceipt, sendReceiptsDir, receiptDayKey, receiptFileName,
  // D11-A (f56dcc08f048) — exported for direct unit testing:
  pickSurvivor, isRoutingLiveRow, isRoutingLiveRowStrict,
};
