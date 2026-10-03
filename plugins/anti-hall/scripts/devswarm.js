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
//                  [--with-broadcasts]  (non-acking only) also merge the project's broadcasts
//                  (newest 50, kind:'broadcast', ordered by seq) into `messages`; `broadcastCount` reports them.
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
//   inbox tick <id> [--child]
//                  D13 (v0.97.0): the mailbox-wake CRON's one-command drain — with
//                  `--child` runs `inbox pull` first (same as the child branch
//                  above), then reports the SAME shape `inbox count` does, PLUS
//                  writes a wake-tick marker (wake-tick/<id>.json) devswarm-child-
//                  gate.js reads to skip a redundant forced heartbeat, refreshes
//                  heartbeats/<id>.json's ts (cheap liveness signal), and — only
//                  when unread>0 AND a Monitor watcher lock exists for `id` —
//                  appends one line to cron-found-mail.jsonl (capped, `doctor
//                  --check` reports its count) so cron's residual value past
//                  Monitor becomes measurable instead of assumed.
//   ready-check <sha> [--base origin/main] [--allow 'glob,glob'] [--watch-deletions 'dir,dir'] [--fetch] --json
//                  peer utility: a generic, READ-ONLY readiness verdict for a
//                  child's "READY <sha>" claim (any project, not DevSwarm-
//                  specific). Reports ff (merge-base --is-ancestor base sha),
//                  files (diff --stat count + list), gitlinks (mode 160000
//                  entries changed), deletions_under (deleted files under
//                  --watch-deletions' dirs, e.g. '.planning'), outside_allowed
//                  (files matching none of --allow's globs), and a verdict
//                  (ok|review|block) + reasons[]. Runs git read-only against
//                  THIS cwd — no fetch unless --fetch is passed.
//   workspaces list
//                  derive + emit summary.json projection (unread, gates, archive_ready).
//   gate <id> [--set CSV] [--clear CSV]
//                  mark/unmark named completion gates (append-only in the store).
//                  anti-hall is AGNOSTIC about gate meaning — the consumer sets them.
//   done [<id>] [--summary TEXT]
//                  0.108.3 CHILD verb: sets the `done` gate on the caller's OWN
//                  workspace id (resolved from cwd; an explicit <id> must match)
//                  and sends ONE `[[ANTIHALL_DONE]]` direct message to the Primary
//                  (hash keyed on id + HEAD, so a re-run adds nothing). Never sets
//                  merged/tests_passed: auto-archive proves the merge itself.
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
//   roster [--ack] [--all] [--json]
//                  Plain output is a COMPACT table of LIVE workspaces + one
//                  `+N archived` line (`--all` or ANTIHALL_ROSTER_HIDE_ARCHIVED=0
//                  lists archived rows too; `--json` prints the full JSON object).
//                  ALLOW-listed projection read of this project's shared registry +
//                  `working_on` + `recent[]` broadcast digest. `--ack` (alias of
//                  `mesh read`, D23) advances the CALLER's own broadcast cursor to
//                  head — the ONLY surface that clears `broadcastUnread`. v0.58:
//                  plain `roster` (never `--ack`) additionally FOLDS a read-only
//                  `hivecontrol workspace list children` view into the projection —
//                  a child hivecontrol spawned but that has never yet registered
//                  itself with the store stays visible instead of invisible.
//   mesh read      same as `roster --ack` (D23) — listed separately for discovery.
//                  Top-level arrays: `messages` (same array as `broadcasts`, matching
//                  `inbox read-primary`/`inbox messages`) and `broadcasts` (kept for compat).
//   mesh history [--last N] [--since <iso|30m|2h|1d>]
//                  NEVER-consuming re-read of ALL broadcasts, already-consumed ones
//                  included (= `mesh read --peek --seq 0`; `mesh read --peek --seq N`
//                  re-reads rows after store seq N). No cursor moves.
//                  Flags: `--peek` (no ack), `--seq N` (explicit baseline, implies peek),
//                  `--last N` (only the newest N unseen rows), `--since <iso|30m|2h|1d>`
//                  (only rows at/after that time). --last/--since are PEEK-ONLY: without
//                  --peek (or --seq) they return ok:false reason `filter-requires-peek`
//                  (use --peek, then a plain `mesh read` to consume) — a consuming read
//                  acks to head and would lose the rows a filter hid.
//                  Every row (broadcasts here, direct rows from `inbox messages/read-primary`)
//                  also carries normalized `from`, `text`, `kind` ('broadcast'|'direct');
//                  the legacy keys (`message`/`sender`/`body`) are unchanged.
//                  send / heartbeat --summary / mesh read, run from a cwd that is NOT a git
//                  worktree, fall back to the worktree of the workspace named by
//                  DEVSWARM_BUILDER_ID (its registered descriptor) before `no-project`.
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

// The devswarm.js split: the shared requires, path/lock helpers,
// parseArgs/buildDescriptorFromFlags and the immutable constants live in
// devswarm-lib/core.js; the verb and helper groups live in the sibling modules
// below (pure moves; names are re-bound here so the code below is unchanged).
// Neither core nor the modules require this file at load time: run() and this
// file's export object are handed to core just below.
const core = require('./devswarm-lib/core.js');
const {
  alog, appendIntoPartition, archivedDir, archiveIgnoreDir, buildDescriptorFromFlags, csvList,
  descriptorFreshRepoKey, descriptorPath, descriptorStructuralRepoKey, forceCrossProjectOverride,
  fs, hasArchivedCounterpart, hasFlag, heartbeatsDir, isIdLockHeld, isSafeId, logVerbOutcome, many,
  one, os, parseArgs, primaryCursorPath, readDescriptorFile, readRetiredRedirect,
  recoveryIntentPath, repoKeyForCwd, runningAntiHallVersion, supervisionMetrics, withIdLock,
  withIdLockHeld, workspacesDir, writeRetiredRedirect,
} = core;
const {
  appSessionOnWorktree, broadcastFamilyOwns, callerOwnsRow, callerReaderKey, canonicalMeshId,
  canonicalWorktreeRealPath, childLabelRefusal, childSenderId, computeRowLive,
  currentRegistrySessionId, declaredSelfId, deriveCallerSessionIdFromProcessTree,
  deriveInstanceNonce, deriveReaderNonce, groupRegistryByMeshId, isArchivedForRouting,
  isLiveSessionId, isPrimaryCheckout, isRoutingLiveRow, isRoutingLiveRowStrict,
  maybePromoteUnclaimed, pickSurvivor, promoteUnclaimedRegistrySessions, promoteUnclaimedSession,
  realSessionIdFrom, resolveCallerWorktree, seatRefusal, senderIdentityDetailed,
  shortInstanceNonce,
} = require('./devswarm-lib/identity.js');
const {
  commitInstanceAck, commitNdAck, cursorLogPath, DEFAULT_INSTANCE_CURSOR_STALE_MS, floorCursor,
  gcInstanceCursors, getSeatGuard, instanceBaselinePath, instanceCursorPath, instanceFloor,
  legacySharedCursor, listInstanceCursors, logCursorWrite, parseInstCursorName,
  parseSiblingSeenCursorName, raiseInstanceBaseline, readCursorLog, readInstanceBaseline,
  readSiblingSeenCursor, removeSiblingSeenCursor, setSeatGuard, siblingAckGate, siblingBaseCursor,
  siblingSeenCursorPath, siblingWatermarkCovered, watermarkLockKey, watermarkSafeId,
  withWatermarkLock, writeSiblingSeenCursor,
} = require('./devswarm-lib/cursors.js');
const {
  archivedForwardProvenancePrefix, archiveLeftReason, CONSUMED_HASH_SEED_CAP, consumedDedupSeed,
  foldGroupIntoSurvivor, foldMeshDuplicates, foldSiblingGapRows, forwardArchivedOrphanUnread,
  forwardedOrigHashOf, GHOST_ROW_MAX_AGE_H_DEFAULT, ghostRegistryRows, healRegistry,
  logicalDeliveryKey, MESH_ROW_COPY_FIELDS, meshRowCopy, rehomeAcrossStores, rehomeCore,
  rehomeMiskeyedRow, retireArchivedWorktreeGroup, retireIdentityFamilyDescriptors,
  retireWorktreeDuplicates, stripArchivedForwardPrefix,
} = require('./devswarm-lib/fold.js');
const {
  adoptPrimarySeat, cmdPrimary, cmdRegister, cmdRegisterPrimary, refreshAnchorSession,
  SELF_HEAL_COOLDOWN_MS, selfHeal, selfHealCooldownPath, withSelfHeal,
} = require('./devswarm-lib/register.js');
const {
  canonicalReceiptId, cmdRelay, cmdSend, cmdSendMulti, receiptDayKey, receiptFileName,
  resolveMeshTarget, resolveSendTarget, sendQuietLine, sendReceiptsDir, writeSendReceipt,
} = require('./devswarm-lib/send.js');
const {
  applyRecoveryIntents, appStatePath, cmdAppState, cmdSyncUi, foldArchivedFamilyDescriptors,
  foldArchivedFamilyResumePath, foldArchivedRegistryRows, foldArchivedResumePath,
  foldMeshDuplicatesAllStores, foldReadReceiptsAllStores, healOrphanPartitions,
  healOrphanPartitionsAllStores, identityRekeyReport, importReaderCursorsAllStores,
  markAppArchivedDescriptors, mergeSplitBackendStoresAllStores, messageGaps, migrateOwnerKeys,
  readFoldArchivedFamilyResume, readFoldArchivedResume, reconcileDualPartitionAcksAllStores,
  refreshNamesFromApp, rehomeStrandedProjectDescriptors, repairChildSenderLabelsAllStores,
  repairReaderFloorsAllStores, reRetireResurrectedRows, reRetireResurrectedRowsAllStores,
  retireStaleArchivedMarkers, syncAppState,
} = require('./devswarm-lib/repair.js');
const {
  appLiveArchivedRows, appOnlyArchive, archivedTombstoneIsOrphaned, attemptAppArchive, cmdArchive,
  cmdArchiveIgnore, cmdArchiveRequest, cmdUnarchive, hcArchiveCall, localArchivedAppLive,
  phantomPrimaryRows, resolveArchiveId, skipFilePath,
} = require('./devswarm-lib/archive.js');
const {
  cmdDone, cmdGate, cmdGateIntent, cmdLogs, cmdMigrate, cmdNudge, cmdSkip, cmdWakeDirective,
  cmdWorkspacesList, emitKnownWarning, parseSinceDuration,
} = require('./devswarm-lib/misc-verbs.js');
const {
  cmdDiagnose, cmdHealthcheck, cmdMeshRead, cmdReadyCheck, cmdRoster, computeDiagnosis,
  computeInstanceNonceCounts, diagnoseHumanLine, fetchActiveWorkspaceRecords, healthcheckHumanLine,
  rosterHints, rosterHumanText,
} = require('./devswarm-lib/roster-diag.js');
const {
  checkSpawnLaunch, cmdMergeVerb, cmdRespawn, cmdSpawn, deriveTitleFromBrief, gitCommonDirFor,
  parseSubmoduleWorktreeFailures, remoteRefAgeSec, repairSubmoduleWorktrees,
  SPAWN_LAUNCH_WAIT_MAX_MS, spawnLaunchWaitMs, spawnLaunchWaitRequestedMs, spawnSourceFreshness,
} = require('./devswarm-lib/spawn.js');
const {
  cmdReapOrphans, cmdReapStale, cmdReconcile, cmdReconcileActive, cmdReconcileRegistry,
  collectOrphanCandidates, reapedDir,
} = require('./devswarm-lib/reconcile.js');
const {
  cmdInboxMessages, inboxWindowRejection, parseInboxSince, resolveReadArgToId,
} = require('./devswarm-lib/inbox-read.js');
const {
  cmdInbox, inboxReadPrimaryTextLines, inboxTickQuietLine,
} = require('./devswarm-lib/inbox-cmd.js');
const {
  cmdCorrect, cmdHeartbeat, cmdPlan, cmdScope,
} = require('./devswarm-lib/heartbeat-plan.js');
core.setRun(run);

// (Phase 3: listNdInstanceCursors / resolveNdCursorPath / projectNdDescriptorCursor
// are deleted — the NDJSON read position is the reader_cursors 'nd' row, and the
// descriptor cursor is only the one-release upward dual-write of its floor.)

// (Phase 3: raiseAllInstanceCursors is deleted — fold/reap raise every reader row
// in one txn via readerCursors.raiseAllLossFree.)

// reconcileOrphanCursor — DELETED in Phase 3 (mesh redesign). It was the one
// allowed REWIND (`allowRewind`), and existed only because the json/store cursor
// pair could disagree. With one reader_cursors table there is no pair left to
// reconcile, every write is MAX-only, and the floor never decreases (I2 holds by
// construction).

// ndjsonHashesFromLines / ndjsonAllHashes — MOVED to companion/lib/devswarm-unread.js
// (the canonical copy, shared with hooks + liveness.js; devswarmUnread.unionUnread
// above now does this work internally, so nothing in this file calls these two
// directly anymore).

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

// ============================================================================
// v0.58 lifecycle wrappers (reconcile / spawn / merge) — PLAN.md CLI VERB
// CONTRACT. spawn/merge are THIN pass-through wraps: hivecontrol's own flag
// grammar is NEVER re-parsed by this file's `parseArgs` (which only recognizes
// `--long` flags) — the dispatcher instead hands these two verbs the RAW
// argv tail (see `run()` below), so every hivecontrol flag (present or future,
// short OR long form, e.g. `-p`/`--prompt`) forwards byte-for-byte.
// ============================================================================

// ----- help (D4 P0 fix) -----
// devswarm.js had NO help support at all: `--help`/`-h` fell through to real
// verb dispatch — for `register-primary`/`migrate`/`migrate-owner-keys` that
// meant a live mutation, and for `merge`/`spawn` (raw-argv-tail pass-through
// verbs) it meant forwarding straight to the hivecontrol child process, with
// `merge` additionally emitting an UNCONDITIONAL mesh broadcast on top. See
// isHelpRequest()'s call site in run() — it is checked BEFORE the switch, so
// this covers every verb, including the two pass-through ones, with zero
// store opens, zero filesystem writes, and zero process spawns.
//
// VERB_HELP maps every verb name to { synopsis, mutates }. `mutates` is a
// short note naming the concrete side effect(s) the verb has when ACTUALLY
// run (never when merely asking for its help) — required so a caller reading
// `help <verb>` knows before running it whether it is safe to explore.
const VERB_HELP = {
  register: { synopsis: 'register a new workspace descriptor', mutates: 'writes the descriptor file + store registry + summary' },
  ensure: { synopsis: 'like register, but idempotent: creates the descriptor when absent, otherwise keeps the existing one (backfilling missing fields only); refuses an archived workspace', mutates: 'writes the descriptor file + store registry + summary' },
  heartbeat: { synopsis: 'record a liveness heartbeat for a workspace [--summary TEXT] [--step N --status doing|done|blocked] (--step records progress on the workspace\'s step plan)', mutates: 'writes a heartbeat file; may emit a mesh broadcast; --step updates the plan file' },
  scope: { synopsis: 'scope add <id> --glob <glob> [--glob …] --note TEXT — child: record extra work the user asked for, so the off-scope straying signal treats it as sanctioned and the Primary sees the note (idempotent)', mutates: 'writes the plan file\'s extras' },
  'supervision-report': { synopsis: 'supervision-report [--days N] [--json] — how DevSwarm supervision performed: straying warnings by signal, repeats, corrections followed by step progress, extras tagged, time-to-done and steps done vs planned, Jev shadow agreement (default 7 days)', mutates: 'nothing (read-only)' },
  respawn: { synopsis: 'respawn <id> [--dry-run] — Primary only, after a `correct` warning and devswarm.respawnGraceMin minutes: ask the child to commit+push, park anything left on a new pushed park/<branch>-<ts> branch (abort if that fails), write plans/<id>.handover.md, spawn <branch>-r<N> from the default branch with the handover + remaining steps, archive the old id (--dry-run prints the plan only)', mutates: 'one mesh send, a new park branch (pushed), the handover file, a new workspace, the old workspace archived' },
  correct: { synopsis: 'correct <id> [--dry-run] — Primary: send a straying child the correction "step N \'<text>\': <reasons>. Return to step N or reply BLOCKED <why>" and record warned_at (--dry-run prints it only)', mutates: 'one mesh-direct send + the plan file\'s warned_at' },
  plan: { synopsis: 'plan set <id> --steps "1. …\\n2. …"|--steps-file <path> [--scope glob,glob] — write the workspace\'s numbered step plan (idempotent); plan show <id> — print it with its step label', mutates: '`set` writes ~/.anti-hall/devswarm/plans/<key>.json; `show` is read-only' },
  inbox: { synopsis: 'inbox subcommands: count | read | ack | pull | tick | messages | read-primary | ack-primary | peek-primary | drain-primary-legacy (drain = read-primary, consume, then the returned ack-primary --receipt command). '
    + '`tick <id> [--child]` is the mailbox-wake cron\'s one-command drain: with --child it runs `pull` first, then reports the `count` shape and writes the wake-tick marker + heartbeat ts. '
    + '`read-primary <id> --format text` prints one `from/seq/body` line per message instead of the raw JSON (still two-step by default: nothing is acked). '
    + '`read-primary <id> --ack-after-print` is opt-in: acks immediately after printing (equivalent to running the returned `ackCommand` right away) — omit it and the two-step read-then-`ack-primary --receipt` default is unchanged. '
    + '`inbox messages <id> [--limit N] [--since <index>|<ISO date>] [--tail N]` bounds a non-acking read: --since (a per-partition message index, or a parseable date such as ISO 8601) filters to rows at/after that point BEFORE the per-source --limit cap is applied, so a recent window is never emptied by an old, oversized inbox; --tail N keeps only the newest N of what --since (if given) returned, and refuses outright (rather than guess) if the --limit cap itself still truncated. --since/--tail are rejected on any ack-bearing call (read-primary/ack/pull/etc) — use the non-acking `messages` read for a bounded view.',
    mutates: '`pull`/`ack`/`ack-primary`/`drain-primary-legacy` mutate cursors; `tick` writes the wake-tick marker + heartbeat ts (and pulls with --child); `read-primary` writes only a read receipt (or also acks, with --ack-after-print); the rest are read-only' },
  primary: { synopsis: 'primary [status|takeover] [--session S] — status (default, read-only) prints this checkout\'s Primary-seat verdict; takeover re-registers the Primary seat to this session (--force), demoting the other holder (run it in the Primary checkout)', mutates: '`status` is read-only; `takeover` rewrites the Primary descriptor/registry row' },
  'ready-check': { synopsis: 'ready-check <sha> [--base <ref>] [--allow glob,glob] [--watch-deletions dir,dir] [--fetch] — read-only readiness verdict (ok|review|block) for a child\'s "READY <sha>" claim: fast-forward vs base (default origin/main), gitlink changes, watched-dir deletions, files outside --allow', mutates: 'read-only (--fetch runs `git fetch`)' },
  workspaces: { synopsis: 'list registered workspaces', mutates: 'read-only' },
  gate: { synopsis: 'set/clear merge gates on a workspace (--set/--clear)', mutates: 'writes gate state to the store' },
  done: { synopsis: 'child: report this workspace done (sets the `done` gate on your own id + one [[ANTIHALL_DONE]] message to the Primary; idempotent) [--summary TEXT]', mutates: 'writes the done gate + one mesh-direct message to the Primary' },
  nudge: { synopsis: 'send a nudge command to a workspace', mutates: 'runs the configured nudge command against the workspace' },
  archive: { synopsis: 'archive (tombstone) a workspace registry row', mutates: 'writes an archive tombstone to the store' },
  'reap-orphans': { synopsis: 'clean up orphaned partitions across stores', mutates: 'mutates store partitions; may rehome/heal registry rows' },
  'reconcile-registry': { synopsis: 'reconcile the workspace registry against descriptors on disk', mutates: 'writes registry rows' },
  unarchive: { synopsis: 'restore a previously archived workspace', mutates: 'reverses an archive tombstone in the store' },
  'archive-ignore': { synopsis: 'mark an archived workspace to be ignored by reap/heal', mutates: 'writes an ignore marker' },
  'archive-unignore': { synopsis: 'clear the archive-ignore marker on a workspace', mutates: 'removes an ignore marker' },
  'archive-request': { synopsis: 'request another session archive its own workspace', mutates: 'mesh-direct store write' },
  'register-primary': { synopsis: 'register the primary session for the current project', mutates: 'MUTATES the store — writes a primary registry row derived from cwd' },
  migrate: { synopsis: 'run the store forward-migration', mutates: 'MUTATES the store — this is a real migration run, not a dry check' },
  logs: { synopsis: 'query the shared devswarm JSONL log', mutates: 'read-only' },
  'migrate-owner-keys': { synopsis: 'forward-migrate descriptor owner keys', mutates: 'MUTATES descriptor files on disk' },
  send: { synopsis: 'send a mesh message: --to <id>[,<id2>…]|--to-primary|--broadcast --message TEXT|--message-file <path>|--message-stdin [--urgency low|normal|high|urgent] [--question] [--answers] [--quiet] [--cc-primary]. `--quiet` prints one line ("sent seq N -> X, B bytes, ok") instead of the full JSON, and still prints "ok:false ..." + a non-zero exit on failure. `--cc-primary` (direct --to sends only) ALSO copies the Primary with the identical message body, best-effort — reported under the result\'s `ccPrimary`, never flips the primary send\'s own ok/exit code. Several recipients (`--to a,b` or a repeated `--to`, deduped) each get the same body; every one is attempted, results come back per recipient (ok, seq, bytes), and the exit is non-zero if any failed.', mutates: 'MUTATES the store — appends a mesh message (and, with --cc-primary, a second one to the Primary) and may wake recipients' },
  relay: { synopsis: 'relay <seq|receipt> --to <id> [--note-file <path>] — forward a message THIS caller already received (its own inbox) to <id> verbatim, prefixed with a provenance header ("relayed from X, seq N, M bytes"). <seq> is the row\'s own `seq` (from `inbox messages`/`read-primary`); <receipt> is a read-primary readReceiptId and resolves only when it covers exactly one message. relay never acks: the read still needs its own `inbox ack-primary --receipt <receipt>`. Verifies the relayed byte length against the source and refuses (ok:false) on a mismatch or an empty source body — never a silent partial relay. Example: `relay 42 --to sibling-workspace-id`.', mutates: 'MUTATES the store — appends one mesh message (via `send`, under this file\'s own Primary-seat gate)' },
  roster: { synopsis: 'show the mesh roster as a compact table of live workspaces (--all adds archived rows, --json prints the full data, --ack clears your own broadcast-unread)', mutates: 'read-only, unless --ack is passed (clears broadcastUnread)' },
  'wake-directive': { synopsis: 'reprint the SessionStart mailbox wake directive', mutates: 'read-only' },
  diagnose: { synopsis: 'read-only mesh-health projection', mutates: 'read-only' },
  'app-state': { synopsis: 'DevSwarm app-DB summary: open workspaces by sidebar rank, PR/brief signals, session map, drift, message gaps (--json)', mutates: 'read-only' },
  'sync-ui': { synopsis: 'reconcile a transcribed DevSwarm sidebar screenshot (--titles-json <file>|--stdin) against the app DB; dry run unless --yes', mutates: 'with --yes: archived markers (app-DB-proven only, never deletes) + names cache' },
  'app-sync': { synopsis: 'run the supervisor app-DB sync now (archived markers, names cache, app-state.json; --dry-run)', mutates: 'writes archived markers (never deletes), names cache, app-state.json' },
  healthcheck: { synopsis: 'pass/fail health gate over the same data as diagnose', mutates: 'read-only' },
  mesh: { synopsis: 'mesh subcommands: read', mutates: 'read-only' },
  reconcile: { synopsis: 'rehome/heal descriptors across stores', mutates: 'MUTATES the store — rehomes descriptors, heals the registry, spawns `inbox pull` per descriptor' },
  'reap-stale': { synopsis: 'reap stale workspaces past their liveness window', mutates: 'MUTATES the store — archives/tombstones stale rows' },
  'reconcile-active': { synopsis: 'reconcile active workspaces against liveness', mutates: 'MUTATES the store' },
  // A (peer request, verified 2026-09-26 via `hivecontrol workspace create --help` on the
  // installed DevSwarm CLI, read-only): `spawn` is a THIN raw-argv-tail pass-through
  // straight to `hivecontrol workspace create <branch>` (see cmdSpawn's own header) —
  // every flag below is hivecontrol's OWN grammar, forwarded byte-for-byte, EXCEPT
  // `--from-local`, which anti-hall strips before forwarding (hivecontrol would reject
  // it; it overrides the spawnFromOrigin freshness refusal — see spawnSourceFreshness).
  spawn: { synopsis: 'spawn <branch> [-s|--source <branch>] [-a|--agent <agent>] [-p|--prompt <text>] [-r|--remote] [-t|--title <title>] [--from-local] — create a new workspace '
    + 'via `hivecontrol workspace create` (raw argv tail forwarded verbatim; anti-hall adds ONLY `--from-local`, which it strips before forwarding). '
    + '-s/--source: source branch to branch from (default: your current branch). -a/--agent: AI agent to use (default: repo default, then claude). '
    + '-p/--prompt: initial prompt for the AI to start on immediately (also used to derive the workspace title when -t is absent). '
    + '-r/--remote: use an existing remote branch (fetches from origin). -t/--title: display title (defaults to the branch name; anti-hall applies it via a separate '
    + 'update-title follow-up, reported as `titled`). --from-local: spawn from local HEAD even when it is stale/diverged from origin (anti-hall\'s own freshness gate; never forwarded to hivecontrol). '
    + 'Example: `spawn feature/foo -p "implement X end to end" -t "Feature X"`. '
    + 'Follow-up brief to an already-spawned child: `send --to <childId> --message "..."` (mesh-direct, this file\'s own delivery+ack path) — hivecontrol\'s own '
    + '`workspace message-child <branch> "<message>"` also exists but bypasses anti-hall\'s mesh/ack bookkeeping, so prefer `send`. '
    + 'Read a child\'s status: `roster` (mesh-wide liveness/gates) or `inbox pull <childId>`/`inbox messages <childId>` (its own inbox).',
    mutates: 'MUTATES — forwards the raw argv tail straight to the hivecontrol child process' },
  merge: { synopsis: 'check-merge + merge-into-source via hivecontrol (raw argv pass-through)', mutates: 'MUTATES — forwards to hivecontrol AND unconditionally sends a mesh broadcast reporting the outcome' },
  skip: { synopsis: 'skip <guard> [--ttl <minutes>] — temporarily disable an anti-hall guard', mutates: 'writes a skip-file entry' },
  'gate-intent': { synopsis: 'record a stated-intent signal for the Stop-hook parent gate', mutates: 'writes a gate-intent record' },
  'auto-archive': { synopsis: 'show the auto-archive plan (done+merged+clean+no-unread+idle workspaces)', mutates: 'read-only' },
  'prune-archived': { synopsis: 'prune-archived --older-than <days> (dry run) | --confirm-ids <ids> --plan <nonce>', mutates: 'dry run writes a plan file; --confirm-ids DELETES the listed archived workspaces via hivecontrol (owner-approved only)' },
  retention: { synopsis: 'message retention: status | run [--dry-run] [--store X] | restore --store X --month yyyy-mm', mutates: '`run` archives then prunes old message bodies (rows, positions and hashes stay) and VACUUMs; `restore` re-imports an archive month; `status`/`run --dry-run` are read-only' },
  notice: { synopsis: 'notice --post "<text>" [--ttl 7d] | notice --list — the anti-hall dev agent\'s cross-project maintainer broadcast', mutates: '`--post` appends one entry to ~/.anti-hall/devswarm/maintainer-notices.jsonl (refused unless devswarm.maintainerNotice.post=true AND this checkout is anti-hall itself); `--list` is read-only' },
};
// verbListFromSwitch() — the verb names actually dispatched by run()'s own
// switch statement, extracted from run's own source text. Deliberately NOT
// hand-typed (the pre-existing hand-typed list in the `default:` branch's
// error message had already drifted — `reconcile-registry` and
// `wake-directive` are real, dispatched verbs missing from it) so this list
// can never go stale again.
function verbListFromSwitch() {
  const src = runArmed.toString(); // the dispatch switch (run() is the guard wrapper)
  const seen = [];
  const re = /case '([a-z][a-z0-9-]*)':/g;
  let m;
  while ((m = re.exec(src))) { if (seen.indexOf(m[1]) === -1) seen.push(m[1]); }
  return seen;
}
function topLevelUsage() {
  const verbs = verbListFromSwitch();
  const lines = ['usage: devswarm.js <verb> [args] [--help]', '', 'verbs:'];
  for (const v of verbs) {
    const info = VERB_HELP[v] || { synopsis: '(no synopsis on file)', mutates: null };
    lines.push('  ' + v + ' — ' + info.synopsis + (info.mutates && info.mutates !== 'read-only' ? '  [' + info.mutates + ']' : ''));
  }
  lines.push('', 'Run `devswarm.js help <verb>` or `devswarm.js <verb> --help` for detail on one verb.');
  return lines.join('\n');
}
function verbUsage(verb) {
  const verbs = verbListFromSwitch();
  if (verbs.indexOf(verb) === -1) {
    return 'unknown verb: ' + JSON.stringify(verb) + '\n\n' + topLevelUsage();
  }
  const info = VERB_HELP[verb] || { synopsis: '(no synopsis on file)', mutates: null };
  const lines = ['usage: devswarm.js ' + verb + ' [args]', '', info.synopsis];
  if (info.mutates) lines.push('', 'side effects: ' + info.mutates);
  return lines.join('\n');
}
// buildHelpResult(verb) -> a normal { ok:true, action:'help', ... } result,
// exactly like every other verb returns. ZERO side effects: no store open, no
// registry read, no filesystem write, no child process.
function buildHelpResult(verb) {
  const verbs = verbListFromSwitch();
  const text = verb ? verbUsage(verb) : topLevelUsage();
  return {
    ok: true, action: 'help', verb: verb || null,
    known: verb ? verbs.indexOf(verb) !== -1 : true,
    verbs,
    usage: text,
  };
}
// SHORT_HELP_LINE_MAX — `help --short` prints ONE line per verb ("verb —
// purpose"), so a multi-clause VERB_HELP synopsis (several of them run to
// full paragraphs documenting every flag — send/spawn/relay/inbox) is cut to
// its first line and capped at this length, ellipsised if still over.
const SHORT_HELP_LINE_MAX = 100;
function shortSynopsis(text) {
  const line = String(text == null ? '' : text).split('\n')[0].trim();
  if (line.length <= SHORT_HELP_LINE_MAX) return line;
  return line.slice(0, SHORT_HELP_LINE_MAX - 1).trimEnd() + '…';
}
// buildShortHelpText() / buildShortHelpResult() — peer request (a DevSwarm
// Primary spent a day driving raw hivecontrol because it never knew
// `devswarm.js archive` existed): a one-line-per-verb index, generated from
// the SAME source of truth as the full help (verbListFromSwitch() +
// VERB_HELP) so it can never drift from the real dispatcher or from
// `help`/`help <verb>`. ZERO side effects, same as buildHelpResult().
function buildShortHelpText() {
  const verbs = verbListFromSwitch();
  const lines = [];
  for (const v of verbs) {
    const info = VERB_HELP[v] || { synopsis: '(no synopsis on file)' };
    lines.push(v + ' — ' + shortSynopsis(info.synopsis));
  }
  return lines.join('\n');
}
function buildShortHelpResult() {
  const verbs = verbListFromSwitch();
  return {
    ok: true, action: 'help', short: true, verb: null, known: true,
    verbs,
    usage: buildShortHelpText(),
  };
}
// isHelpRequest(positionals, flags) -> true when this argv is asking for help
// rather than dispatching a real verb. Deliberately checked in run() BEFORE
// the switch, so it short-circuits every verb including the raw-argv-tail
// pass-through ones (`spawn`/`merge`).
//
// `-h` is a SINGLE-dash token, so parseArgs' own `tok.startsWith('--')` gate
// never routes it into `flags` — it always lands in `positionals`, at
// whatever position it was typed. Checking only `positionals[0]` (as an
// earlier version of this fix did) caught a BARE `-h` but missed `-h` on
// every real subcommand (`migrate -h`, `merge -h`, `register-primary -h`,
// `reconcile -h`, ...) — those fell through to real dispatch, so
// `migrate -h` genuinely ran the migration and `merge -h` genuinely
// broadcast to the mesh. Fix: scan every positional for a literal `-h`
// token, not just position 0 — option (a) from the fix-up, chosen over
// teaching parseArgs to treat `-h` as a flag alias (option (b)) because (b)
// changes tokenisation for every verb (e.g. any existing caller passing a
// literal `-h` as a VALUE — impossible here since `-h` would only ever land
// in positionals in the first place, never consumed as a flag's value,
// because the generic "does the next token start with --" swallow heuristic
// only fires for `--`-prefixed flags) and is a wider blast radius than this
// P0 needs. A bona fide workspace id literally equal to `-h` (isSafeId
// permits it: `/^[A-Za-z0-9._-]+$/`) would be misread as a help request —
// accepted, standard CLI ergonomics (most CLIs treat `-h` as help wherever
// it appears), and the id would still work fine passed any other way.
function isHelpRequest(positionals, flags) {
  if (flags.help || flags.h) return true;
  for (let i = 0; i < positionals.length; i++) {
    if (positionals[i] === 'help' && i === 0) return true;
    if (positionals[i] === '-h') return true;
  }
  return false;
}

// run(argv, ctx) -> { code, result }. ctx: { home, env, backend, now } (all
// injectable for tests). NEVER throws — any internal error becomes a
// { ok:false, error } result with exit code 2.
function run(argv, ctx0) {
  // envExplicit: true only when the CALLER (ctx0) supplied its own `env` key
  // — an in-process embedder (tests, another in-process caller), never the
  // real CLI's own default. Consulted by ownerAppDbEnv() so the (a0)
  // first-claim ownership leg never honors ANTIHALL_DEVSWARM_APP_DB out of
  // a real invocation's plain `process.env` default (0.117.1 round 3, P0
  // R2-P0-env-forged-appdb-impersonation).
  const envExplicit = !!(ctx0 && Object.prototype.hasOwnProperty.call(ctx0, 'env'));
  const ctx = Object.assign({ home: os.homedir(), env: process.env }, ctx0 || {});
  ctx.envExplicit = envExplicit;
  const { positionals, flags } = parseArgs(argv || []);
  const cmd = positionals[0];
  // D4 P0 fix: help intercept runs BEFORE the switch — see isHelpRequest()'s
  // own header for why this is the only insertion point that covers every
  // verb, including spawn/merge's raw-argv-tail forwarding.
  if (isHelpRequest(positionals, flags)) {
    const verb = cmd === 'help' ? positionals[1] : (cmd === '-h' ? undefined : cmd);
    // `help --short` / `--help --short` (no verb): one line per verb, same
    // source of truth as the full listing — see buildShortHelpResult().
    if (flags.short && !verb) {
      return { code: 0, result: buildShortHelpResult() };
    }
    return { code: 0, result: buildHelpResult(verb) };
  }
  // Arm the cursor-door seat guard for THIS invocation (see
  // assertSeatAllowsCursorWrite); disarmed again when run() returns.
  // Re-entrant: a nested run() restores the outer invocation's guard.
  const prevGuard = getSeatGuard();
  setSeatGuard(ctx, undefined);
  try { return runArmed(cmd, positionals, flags, ctx, argv); }
  catch (e) {
    if (e && e.seatRefusal) return { code: 2, result: Object.assign({ action: cmd }, e.seatRefusal) };
    throw e;
  } finally { setSeatGuard(prevGuard.ctx, prevGuard.verdict); }
}

function runArmed(cmd, positionals, flags, ctx, argv) {
  // v0.108.0 Primary seat: a session that does not hold a LIVE-held seat may
  // not send, ack, spawn or merge-broadcast as the Primary.
  if (cmd === 'send' || cmd === 'relay' || cmd === 'spawn' || cmd === 'merge' || cmd === 'correct'
      || (cmd === 'inbox' && (positionals[1] === 'ack' || positionals[1] === 'ack-primary'))) {
    const refusal = seatRefusal(ctx);
    if (refusal) return { code: 2, result: Object.assign({ action: cmd }, refusal) };
  }
  try {
    switch (cmd) {
      case 'primary': {
        const r = cmdPrimary(positionals[1], flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'register': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const labelRefusal = childLabelRefusal(id, flags, ctx);
        if (labelRefusal) return { code: 2, result: Object.assign({ action: 'register' }, labelRefusal) };
        const r = cmdRegister(id, flags, ctx);
        logVerbOutcome('register', id, r, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'ensure': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const labelRefusal = childLabelRefusal(id, flags, ctx);
        if (labelRefusal) return { code: 2, result: Object.assign({ action: 'ensure' }, labelRefusal) };
        const r = cmdRegister(id, flags, ctx, { requireNew: true });
        logVerbOutcome('ensure', id, r, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'heartbeat': {
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const labelRefusal = childLabelRefusal(id, flags, ctx);
        if (labelRefusal) return { code: 2, result: Object.assign({ action: 'heartbeat' }, labelRefusal) };
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
        if (sub === 'pull' || sub === 'messages' || sub === 'read-primary' || sub === 'peek-primary'
          || sub === 'ack-primary' || sub === 'drain-primary-legacy') {
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
      case 'done': {
        // 0.108.3: child-facing structured done-report (sets the `done` gate on
        // the caller's OWN id + one [[ANTIHALL_DONE]] message to the Primary).
        const r = cmdDone(positionals[1], flags, ctx);
        logVerbOutcome('done', r && r.id, r, ctx);
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
        // Already archived in anti-hall but still LIVE in the app: archive the app side only.
        const appOnly = appOnlyArchive(rawId, ctx);
        if (appOnly) return { code: appOnly.ok && !appOnly.partial ? 0 : 2, result: appOnly };
        if (!isSafeId(rawId)) return { code: 2, result: { ok: false, error: 'invalid or missing workspace id' } };
        const resolved = resolveArchiveId(rawId, ctx);
        if (!resolved.ok) return { code: 2, result: Object.assign({ action: 'archive', id: rawId, descriptorArchived: false }, resolved) };
        const r = cmdArchive(resolved.id, ctx, { flags });
        return { code: r.ok && !r.partial ? 0 : 2, result: r };
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
        const resolvedU = resolveArchiveId(id, ctx);
        if (resolvedU.candidates) return { code: 2, result: Object.assign({ action: 'unarchive', id }, resolvedU) };
        const r = cmdUnarchive(resolvedU.ok ? resolvedU.id : id, ctx);
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
        const resolvedR = resolveArchiveId(id, ctx);
        if (resolvedR.candidates) return { code: 2, result: Object.assign({ action: 'archive-request' }, resolvedR, { id }) };
        const reqId = resolvedR.ok ? resolvedR.id : id;
        const r = withSelfHeal(() => cmdArchiveRequest(reqId, flags, ctx), ctx);
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
        // --cc-primary (peer request F) needs the SAME resolved message body
        // for both the sibling send and the Primary cc. --message/--message-
        // file are safe to re-read from `flags` a second time, but a REAL
        // --message-stdin reads fd 0, which a real pipe can only ever supply
        // once — pre-resolve it here into `ctx.io.stdin` (cmdSend already
        // prefers a string there over re-reading fd 0) so both sends below
        // consume the identical, already-captured body, never fd 0 twice.
        let sendCtx = ctx;
        if (hasFlag(flags, 'cc-primary') && hasFlag(flags, 'message-stdin') && !(ctx.io && typeof ctx.io.stdin === 'string')) {
          let stdinBody;
          try { stdinBody = fs.readFileSync(0, 'utf8'); }
          catch (e) { stdinBody = undefined; }
          if (stdinBody !== undefined) sendCtx = Object.assign({}, ctx, { io: Object.assign({}, ctx.io, { stdin: stdinBody }) });
        }
        // MULTI-RECIPIENT (0.112, setting devswarm.sendMultiRecipient): `--to a,b`
        // or a repeated `--to` sends the SAME body to each recipient (deduped,
        // in order) so a caller never needs a shell `for` loop. See
        // cmdSendMulti. A single recipient (after dedupe) takes the unchanged
        // single-send path below with the normalized id.
        let multiOn = true;
        try { multiOn = require('../hooks/lib/settings.js').get('devswarm', 'sendMultiRecipient', true, { env: ctx.env || process.env, home: ctx.home }) !== false; } catch (_) { multiOn = true; }
        if (multiOn && many(flags, 'to').length) {
          const recipients = csvList(flags, 'to');
          if (recipients.length > 1) {
            const mr = cmdSendMulti(recipients, flags, sendCtx);
            return { code: mr.ok ? 0 : 2, result: mr };
          }
          if (recipients.length === 1) flags.to = [recipients[0]];
        }
        // Send-time self-heal (Phase 7): runs before every mesh send.
        const r = withSelfHeal(() => cmdSend(flags, sendCtx), sendCtx);
        logVerbOutcome('send', one(flags, 'to'), r, sendCtx);
        // --cc-primary (peer request F): deliver to the sibling addressed by
        // --to, AND copy the Primary, so two lanes can coordinate while the
        // Primary still sees it. Best-effort/additive: fires ONLY on a
        // successful direct --to send (never --broadcast/--to-primary, and
        // never when the first send itself failed) and can NEVER flip the
        // primary send's own `ok`/exit code — its own outcome is reported
        // under `ccPrimary` on the result, exactly like `retiredDuplicates`
        // etc. do elsewhere in this file.
        if (r && r.ok && hasFlag(flags, 'cc-primary') && r.type === 'direct' && one(flags, 'to') !== undefined) {
          const ccFlags = Object.assign({}, flags, { to: undefined, broadcast: undefined, 'to-primary': [true] });
          delete ccFlags.to;
          delete ccFlags.broadcast;
          try {
            const cc = withSelfHeal(() => cmdSend(ccFlags, sendCtx), sendCtx);
            r.ccPrimary = cc;
            logVerbOutcome('send-cc-primary', 'primary', cc, sendCtx);
          } catch (e) {
            r.ccPrimary = { ok: false, error: 'cc-primary send threw: ' + String((e && e.message) || e) };
          }
        }
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'relay': {
        const seqOrReceipt = positionals[1];
        const r = withSelfHeal(() => cmdRelay(seqOrReceipt, flags, ctx), ctx);
        logVerbOutcome('relay', one(flags, 'to'), r, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'roster': {
        // `roster --ack` is an alias of `mesh read` (D23) — both clear the
        // caller's own broadcastUnread; plain `roster` is a read-only projection.
        const r = hasFlag(flags, 'ack') ? cmdMeshRead(flags, ctx) : cmdRoster(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'wake-directive': {
        // C (Stop-gate reassert trim follow-up): on-demand reprint of the
        // SessionStart MAILBOX WAKE directive, pure read, never touches the
        // store. See cmdWakeDirective's own header for the full rationale.
        const wid = positionals[1];
        const r = cmdWakeDirective(wid, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'app-state': {
        // v0.108.0: READ-ONLY DevSwarm app-DB summary (fresh snapshot, computed
        // never written) + the last supervisor sync's drift/gap report.
        const r = cmdAppState(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'sync-ui': {
        // v0.108.0 screenshot sync (dry run unless --yes; see cmdSyncUi).
        const r = cmdSyncUi(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'app-sync': {
        // v0.108.0: the supervisor's periodic app-DB sync step, on demand
        // (markers + names cache + app-state.json; --dry-run writes nothing).
        const r = syncAppState(ctx.home, { env: ctx.env, now: ctx.now, dryRun: hasFlag(flags, 'dry-run'), gapCooldownMs: 0 });
        const res = Object.assign({ action: 'app-sync' }, r);
        delete res.state;
        return { code: r.ok ? 0 : 2, result: res };
      }
      case 'diagnose': {
        // READ-ONLY mesh-health projection (#62) — pure, never writes summary.json.
        const r = cmdDiagnose(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'plan': {
        // Meeseeks P1: `plan set <id> --steps …|--steps-file P [--scope …]` / `plan show <id>`.
        const sub = positionals[1];
        const id = positionals[2];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, action: 'plan', error: 'usage: devswarm.js plan set|show <id> …' } };
        const r = cmdPlan(sub, id, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'scope': {
        // Meeseeks P2: the child tags user-requested extra work.
        const id = positionals[2];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, action: 'scope', error: 'usage: devswarm.js scope add <id> --glob <glob> --note TEXT' } };
        const r = cmdScope(positionals[1], id, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'supervision-report': {
        // Meeseeks P2: read-only effectiveness report over the supervision
        // metrics log + daily rollups (companion/lib/devswarm-supervision-metrics.js).
        const daysRaw = one(flags, 'days');
        const days = daysRaw === undefined ? 7 : Number(daysRaw);
        if (!Number.isFinite(days) || days < 1) return { code: 2, result: { ok: false, action: 'supervision-report', error: 'usage: devswarm.js supervision-report [--days N] [--json]' } };
        return { code: 0, result: supervisionMetrics.report(ctx.home, { days, now: Number.isFinite(ctx.now) ? ctx.now : undefined }) };
      }
      case 'respawn': {
        // Meeseeks P3: Primary-run respawn after a warning (never automatic).
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, action: 'respawn', error: 'usage: devswarm.js respawn <id> [--dry-run]' } };
        const r = cmdRespawn(id, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'correct': {
        // Meeseeks P2: the Primary's correction for a straying child.
        const id = positionals[1];
        if (!isSafeId(id)) return { code: 2, result: { ok: false, action: 'correct', error: 'usage: devswarm.js correct <id> [--dry-run]' } };
        const r = cmdCorrect(id, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'healthcheck': {
        // #71: pass/fail gate over the SAME data diagnose computes — pure read,
        // exit 0 = healthy, non-zero = degraded (for monitors/CI/daemon).
        const r = cmdHealthcheck(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'ready-check': {
        // Generic, READ-ONLY readiness verdict for a child's "READY <sha>"
        // claim (peer request A) — see cmdReadyCheck's own header for the
        // full field-by-field contract. `ok` reflects whether the check ITSELF
        // ran (usage error aside, always true — same "report, never gate"
        // posture as `diagnose`); the verdict/reasons fields are what a caller
        // acts on, not the exit code.
        const rSha = positionals[1];
        const r = cmdReadyCheck(rSha, flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'mesh': {
        const sub = positionals[1];
        if (sub === 'read') {
          const r = cmdMeshRead(flags, ctx);
          return { code: r.ok ? 0 : 2, result: r };
        }
        if (sub === 'history') {
          // Never-consuming re-read of ALL broadcasts (incl. already-consumed
          // ones): `mesh read --peek --seq 0` (+ optional --last/--since).
          const hflags = Object.assign({}, flags, { seq: ['0'], peek: [true] });
          const r = cmdMeshRead(hflags, ctx);
          if (r && r.ok) r.action = 'mesh-history';
          return { code: r.ok ? 0 : 2, result: r };
        }
        return { code: 2, result: { ok: false, error: 'unknown mesh subcommand: ' + JSON.stringify(sub || '') + ' (read|history)' } };
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
      case 'auto-archive': {
        // v0.108.0 — READ-ONLY plan: which done workspaces the supervisor's
        // auto-archive would archive now, with the proof/blockers per row.
        // Archiving itself happens only in the supervisor sweep (mode "on").
        const r = require('../companion/lib/devswarm-lifecycle.js').planAutoArchive({ home: ctx.home, env: ctx.env });
        return { code: r.ok ? 0 : 2, result: Object.assign({ action: 'auto-archive' }, r) };
      }
      case 'prune-archived': {
        // v0.108.0 — dry run by default; deletion ONLY via --confirm-ids +
        // --plan <nonce> of a fresh dry run the owner approved. This is the
        // ONE call site of executePrune (hygiene-tested).
        const lifecycle = require('../companion/lib/devswarm-lifecycle.js');
        if (flags['confirm-ids']) {
          const r = lifecycle.executePrune({
            home: ctx.home, env: ctx.env, ids: csvList(flags, 'confirm-ids'), nonce: one(flags, 'plan'),
            archiveDescriptor: (id) => cmdArchive(id, ctx),
          });
          return { code: r.ok ? 0 : 2, result: Object.assign({ action: 'prune-archived' }, r) };
        }
        const r = lifecycle.planPrune({ home: ctx.home, env: ctx.env, olderThanDays: one(flags, 'older-than') });
        return { code: r.ok ? 0 : 2, result: Object.assign({ action: 'prune-archived' }, r) };
      }
      case 'gate-intent': {
        // `gate-intent --reason "<text>" [--session <id>]` — the explicit
        // stated-intent signal devswarm-parent-gate.js's Stop hook consumes.
        // See cmdGateIntent's own header for why this is a CLI verb rather
        // than a transcript-tail keyword scan.
        const r = cmdGateIntent(flags, ctx);
        return { code: r.ok ? 0 : 2, result: r };
      }
      case 'retention': {
        // `retention status | run [--dry-run] [--store X] | restore --store X --month yyyy-mm`
        // — message retention (companion/lib/devswarm-retention.js). `run` acts
        // immediately (the supervisor's first-run dry-run gate is for the
        // automatic sweep only); `--dry-run` reports without writing anything.
        const ret = require('../companion/lib/devswarm-retention.js');
        const sub = positionals[1];
        const storeArg = one(flags, 'store');
        let r;
        if (sub === 'status') r = ret.status({ home: ctx.home, env: ctx.env });
        else if (sub === 'run') r = ret.run({ home: ctx.home, env: ctx.env, now: ctx.now, dryRun: !!(flags['dry-run'] && flags['dry-run'].length), store: storeArg });
        else if (sub === 'restore') r = ret.restore({ home: ctx.home, now: ctx.now, hash: storeArg, month: one(flags, 'month') });
        else r = { ok: false, error: 'usage: retention status | run [--dry-run] [--store X] | restore --store X --month yyyy-mm' };
        return { code: r && r.ok ? 0 : 2, result: r };
      }
      case 'notice': {
        // `notice --post "<text>" [--ttl 7d]` | `notice --list` — the
        // maintainer-notice broadcast (companion/lib/devswarm-maintainer-notice.js).
        // --post is refused unless devswarm.maintainerNotice.post=true AND this
        // checkout's own plugin.json names "anti-hall" (mistake guard, not
        // authentication — see that module's header). No `--list`/`--post` ->
        // usage error (this verb has no implicit default action).
        const notice = require('../companion/lib/devswarm-maintainer-notice.js');
        let r;
        if (hasFlag(flags, 'post')) {
          r = notice.post({ home: ctx.home, env: ctx.env, cwd: ctx.cwd || process.cwd(), now: ctx.now, text: one(flags, 'post'), ttl: one(flags, 'ttl') });
        } else if (hasFlag(flags, 'list')) {
          r = notice.list({ home: ctx.home, now: ctx.now });
        } else {
          r = { ok: false, error: 'usage: notice --post "<text>" [--ttl 7d] | notice --list' };
        }
        return { code: r && r.ok ? 0 : 2, result: r };
      }
      default:
        return { code: 2, result: { ok: false, error: 'unknown command: ' + JSON.stringify(cmd || '') +
          ' (register|register-primary|ensure|heartbeat|inbox|workspaces|gate|gate-intent|nudge|'
          + 'archive|unarchive|archive-ignore|archive-unignore|archive-request|migrate|'
          + 'migrate-owner-keys|logs|send|roster|app-state|app-sync|sync-ui|diagnose|healthcheck|mesh|'
          + 'reconcile|reap-stale|reconcile-active|spawn|merge|skip|auto-archive|prune-archived|'
          + 'retention|notice)' } };
    }
  } catch (e) {
    if (e && e.seatRefusal) throw e; // run() reports it as primary-seat-conflict
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
  emitKnownWarning(argv, result);
  // `healthcheck`/`diagnose` (no --json) print ONE compact human line; every
  // other verb — and either of these WITH --json — prints the raw JSON
  // object. `diagnose` gained a human-line mode alongside healthcheck (field
  // defect c55896250399): a raw JSON dump left a genuinely partitioned mesh's
  // `mixedSplits`/`deadSplits` easy to miss when only the benign `splits`
  // array (correctly empty for those kinds) was eyeballed.
  // `help` gets the same human-line treatment as healthcheck/diagnose (D4
  // fix): checked on `result.action` rather than `argv[0]`, since a help
  // request can arrive as `help`, `-h`, or `<verb> --help` — the verb name in
  // argv[0] varies, but buildHelpResult() always stamps action:'help'.
  const isHelpResult = result && result.action === 'help';
  // inbox read-primary --format text (peer request C) and send --quiet (peer
  // request D): both are opt-in ALTERNATE renderings of an otherwise-JSON
  // verb, same `--json` override precedence as healthcheck/diagnose (an
  // explicit --json always wins, so a caller can force the raw object back).
  const isInboxReadPrimaryText = argv[0] === 'inbox' && argv[1] === 'read-primary'
    && (argv.includes('--format=text') || (argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'text'));
  const isSendQuiet = argv[0] === 'send' && argv.includes('--quiet');
  const isInboxTickQuiet = argv[0] === 'inbox' && argv[1] === 'tick' && argv.includes('--quiet');
  const isSupervisionReport = argv[0] === 'supervision-report' && result && result.ok === true;
  // plain `roster` (no --ack, ok result): compact live-workspace table; --all
  // (or ANTIHALL_ROSTER_HIDE_ARCHIVED=0) adds archived rows, --json = full data.
  const isRosterText = argv[0] === 'roster' && !argv.includes('--ack') && !!result && result.ok === true && result.action === 'roster';
  const wantHuman = (argv[0] === 'healthcheck' || argv[0] === 'diagnose' || argv[0] === 'app-state' || isHelpResult || isSupervisionReport
    || isInboxReadPrimaryText || isSendQuiet || isInboxTickQuiet || isRosterText) && !argv.includes('--json');
  const out = wantHuman
    ? (isRosterText ? rosterHumanText(result, { all: argv.includes('--all') || process.env.ANTIHALL_ROSTER_HIDE_ARCHIVED === '0', home: require('../companion/lib/test-home-guard.js').resolveHome(undefined, process.env), now: Date.now() })
      : argv[0] === 'healthcheck' ? healthcheckHumanLine(result) : (argv[0] === 'diagnose' ? diagnoseHumanLine(result)
      : (argv[0] === 'app-state' ? (result.text || JSON.stringify(result))
        : isSupervisionReport ? supervisionMetrics.formatReport(result)
        : (isInboxReadPrimaryText ? inboxReadPrimaryTextLines(result) : (isSendQuiet ? sendQuietLine(result)
          : (isInboxTickQuiet ? inboxTickQuietLine(result) : result.usage))))))
    : JSON.stringify(result);
  // fs.writeSync(1, ...) per repo rule (macOS node 18/20 exit-vs-async-flush race).
  fs.writeSync(1, out + '\n');
  process.exit(code);
}

module.exports = {
  // item 4a — running anti-hall version stamped onto heartbeat/tick records:
  runningAntiHallVersion,
  appendIntoPartition, isIdLockHeld, withIdLockHeld,
  run, parseArgs, one, many, csvList,
  // peer request B/C/D/F (downstream-project Primaries, 2026-09-26) — exported for
  // direct unit testing:
  cmdRelay, inboxReadPrimaryTextLines, sendQuietLine, inboxTickQuietLine,
  emitKnownWarning, resolveReadArgToId,
  buildDescriptorFromFlags, readDescriptorFile, descriptorPath,
  retireWorktreeDuplicates, isLiveSessionId, archiveLeftReason,
  foldGroupIntoSurvivor, canonicalMeshId, canonicalWorktreeRealPath, groupRegistryByMeshId, foldMeshDuplicates,
  resolveCallerWorktree,
  fetchActiveWorkspaceRecords,
  foldMeshDuplicatesAllStores,
  healOrphanPartitions, healOrphanPartitionsAllStores,
  retireArchivedWorktreeGroup, foldArchivedRegistryRows, foldArchivedFamilyDescriptors,
  reRetireResurrectedRows, reRetireResurrectedRowsAllStores,
  retireIdentityFamilyDescriptors, meshRowCopy, MESH_ROW_COPY_FIELDS, cmdRoster,
  computeDiagnosis, healthcheckHumanLine, diagnoseHumanLine, hasArchivedCounterpart,
  resolveMeshTarget, resolveSendTarget,
  workspacesDir, archivedDir, heartbeatsDir, archiveIgnoreDir, primaryCursorPath, skipFilePath,
  selfHeal, withSelfHeal, SELF_HEAL_COOLDOWN_MS, selfHealCooldownPath,
  migrateOwnerKeys, identityRekeyReport, phantomPrimaryRows, rehomeCore, rehomeAcrossStores, rehomeMiskeyedRow, healRegistry, withIdLock, cmdArchive, archivedTombstoneIsOrphaned,
  resolveArchiveId,
  applyRecoveryIntents, recoveryIntentPath, rehomeStrandedProjectDescriptors,
  cmdWorkspacesList, cmdGate, cmdReconcile, cmdRegister,
  // Meeseeks supervision: the off-scope signal reuses ready-check (companion/lib/devswarm-supervision.js).
  cmdReadyCheck, cmdPlan, cmdScope, cmdCorrect,
  cmdLogs, cmdInboxMessages, parseSinceDuration,
  descriptorFreshRepoKey, descriptorStructuralRepoKey,
  siblingAckGate, cmdInbox,
  // defect 8b211241bbe9 — per-instance cursors, the cursor write journal, and
  // the hygiene pass (exported for doctor/update.js and for direct testing).
  instanceCursorPath, parseInstCursorName, listInstanceCursors, instanceFloor,
  instanceBaselinePath, readInstanceBaseline, raiseInstanceBaseline,
  commitInstanceAck, gcInstanceCursors, DEFAULT_INSTANCE_CURSOR_STALE_MS,
  cursorLogPath, logCursorWrite, readCursorLog, siblingBaseCursor, legacySharedCursor,
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
  // defect d3d571495bf6 — the per-process instance nonce (exported for direct
  // unit testing with an injected ppidOf/pid/fs, same pattern as above):
  deriveInstanceNonce,
  // mesh redesign B5 / Phase 3 — THE nonce every production site uses, plus the
  // reader_cursors adapters:
  hcArchiveCall, deriveReaderNonce, callerReaderKey, commitNdAck, floorCursor, importReaderCursorsAllStores, repairReaderFloorsAllStores, markAppArchivedDescriptors, retireStaleArchivedMarkers, localArchivedAppLive, appLiveArchivedRows, appOnlyArchive, attemptAppArchive, deriveTitleFromBrief, appSessionOnWorktree, refreshNamesFromApp, syncAppState, messageGaps, appStatePath, cmdAppState, cmdSyncUi, repairChildSenderLabelsAllStores,
  // spawn speed + submodule-failure reporting (0.109.0) — exported for direct unit testing:
  spawnSourceFreshness, remoteRefAgeSec, gitCommonDirFor, parseSubmoduleWorktreeFailures, repairSubmoduleWorktrees,
  senderIdentityDetailed, childSenderId, isPrimaryCheckout,
  refreshAnchorSession,
  childLabelRefusal,
  seatRefusal, adoptPrimarySeat, cmdPrimary,
  reconcileDualPartitionAcksAllStores, declaredSelfId,
  mergeSplitBackendStoresAllStores,
  // v0.108.2 read-receipt alias-family canonicalization repair:
  canonicalReceiptId, foldReadReceiptsAllStores,
  // instanceNonce CONSUMERS (defect d3d571495bf6, items a/b/c — exported for
  // direct unit testing, same pattern as deriveInstanceNonce above):
  shortInstanceNonce, computeInstanceNonceCounts,
  // H fix — exported for direct unit testing: readRetiredRedirect's isSafeId
  // guard, writeRetiredRedirect (its counterpart), and cmdMeshRead's --seq
  // bare-boolean guard.
  readRetiredRedirect, writeRetiredRedirect, cmdMeshRead,
  // v0.90.1 P0 cursor-namespace hotfix (exported for direct unit testing):
  siblingBaseCursor, siblingSeenCursorPath, readSiblingSeenCursor, writeSiblingSeenCursor,
  removeSiblingSeenCursor, parseSiblingSeenCursorName, watermarkSafeId,
  siblingWatermarkCovered,
  // D11-A (TOCTOU fix) — exported for direct unit testing:
  watermarkLockKey, withWatermarkLock,
  broadcastFamilyOwns, ghostRegistryRows, GHOST_ROW_MAX_AGE_H_DEFAULT,
  promoteUnclaimedRegistrySessions,
  // defect 64861a623503 — forwarded-copy identity + the fold's dedup seeding:
  foldSiblingGapRows, forwardedOrigHashOf, logicalDeliveryKey,
  stripArchivedForwardPrefix, consumedDedupSeed, CONSUMED_HASH_SEED_CAP,
  forwardArchivedOrphanUnread, archivedForwardProvenancePrefix,
  // v0.90.0 send receipts (writer; the reader is hooks/devswarm-parent-reply-tracker.js):
  writeSendReceipt, sendReceiptsDir, receiptDayKey, receiptFileName,
  // D11-A (f56dcc08f048) — exported for direct unit testing:
  pickSurvivor, isRoutingLiveRow, isRoutingLiveRowStrict, isArchivedForRouting,
  computeRowLive, rosterHints,
  // task #40 (v0.96.1) — companion/devswarm-supervisor.js's deferred-sweep
  // backstop peeks these SAME resume markers (read-only) to decide whether
  // fold-archived-rows has pending work worth a slot, without duplicating
  // the marker path/shape here:
  foldArchivedResumePath, readFoldArchivedResume,
  foldArchivedFamilyResumePath, readFoldArchivedFamilyResume,
  // defect d56bfaac2da0 (submodule-cwd superproject re-resolution) — exported
  // for direct unit testing, same convention as this file's other internals:
  resolveCallerWorktree,
};

// Hand this export object to core so moved callers keep reaching the DISPATCHER's
// exports (a test that swaps an export still affects them, exactly as before).
core.setDispatcherExports(module.exports);

if (require.main === module) {
  main();
}
