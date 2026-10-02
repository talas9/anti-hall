'use strict';
// anti-hall :: devswarm CLI — REPAIR module (scripts/devswarm-lib/repair.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  alog, archivedDir, archiveGateLib, checkedArchivedDir, clearRecoveryIntent, crypto,
  descriptorFingerprint, descriptorFreshRepoKey, descriptorPath, descriptorStructuralRepoKey,
  devswarmRoot, fs, hasArchivedCounterpart, hasFlag, identity, identityContext, inst, isSafeId,
  isSiblingPartitionLive, names, nextHeartbeatTmp, one, path, readDescriptorFile,
  readDescriptorPathState, readerCursors, recoveryIntentDir, registryRowPresent, repokey,
  repoKeyForCwd, resolveOrphanDescriptor, retiredMarkersDir, store, withIdLock, workspacesDir,
} = require('./core.js');
const {
  canonicalMeshId, canonicalWorktreeRealPath, groupRegistryByMeshId, isPrimaryCheckout,
  pickSurvivor, rawPathMeshId,
} = require('./identity.js');
const {
  floorCursor, logCursorWrite, readReceiptDir,
} = require('./cursors.js');
const {
  archiveForwardMaxAgeMs, archiveLeftReason, foldGroupIntoSurvivor, foldMeshDuplicates,
  forwardArchivedOrphanUnread, forwardedOrigHashOf, isForwardable, pickArchiveForwardSurvivor,
  rehomeCore, restoreArchivedDescriptor, retireIdentityFamilyDescriptors,
} = require('./fold.js');
const {
  canonicalReceiptId,
} = require('./send.js');

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
  let retired = 0, forwarded = 0, folded = 0, errors = 0, pending = 0;
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
    pending += r.pending || 0;
    if (n || r.forwarded || r.pending) results.push({ repoKey, ok: true, retired: n, forwarded: r.forwarded || 0, folded: r.folded || 0, pending: r.pending || 0 });
  }
  return { ok: true, stores: hashes.length, retired, forwarded, folded, errors, pending, results };
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
// (Phase 3: no cursor reconciliation here any more — reader_cursors has one
// monotone floor per partition, so there is nothing to reconcile.)
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
//   archivedDrained, archivedStale, skipped, deadlineSkipped, pending, errors,
//   detail }. deadlineSkipped (a subset of skipped) is unfinished work: callers
//   count it as pending so a deadline-cut pass is never stamped done.
function healOrphanPartitions(home, ctx) {
  const c = ctx || {};
  const dryRun = !!c.dryRun;
  // scope — this call heals exactly ONE store (see healOrphanPartitionsAllStores
  // for the cross-store sweep); surfaced so a caller/printer never has to guess
  // which of the two different "orphan" counts (this store vs every store) it is
  // looking at (FIX C).
  const out = {
    ok: true, scope: 'store', adopted: 0, forwarded: 0, unhealable: 0,
    // pending: rows NOT moved this pass because a lock was busy or the survivor
    // vanished (appendIntoPartition) — the pass must not be recorded clean.
    archivedDrained: 0, archivedStale: 0, skipped: 0, deadlineSkipped: 0, pending: 0, errors: 0, detail: [],
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
    // Built ONCE for this store's whole heal pass (defect df54edf54804 item 4
    // parity fix) — see archivedGateFor below.
    const archivedWorktreeIndex = archiveGateLib.buildArchivedWorktreeIndex(home, fs);
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
      for (let wi = 0; wi < withDescriptorIds.length; wi++) {
        const id = withDescriptorIds[wi];
        // BUDGET (D11-C, field-measured: this bucket is the REAL work —
        // adopt/forward — and previously ran to full completion regardless of
        // ctx.deadline, which the no-descriptor bucket below already honored.
        // 45.8s measured against a 20s budget). Stop BEFORE starting the NEXT
        // id once the deadline has passed — same "stop before an item, never
        // mid-item" contract update.js's own runThrottledSweep enforces. The
        // FIRST id always runs regardless of budget (forward-progress
        // guarantee). Deferred ids are counted in `skipped`, NOT `unhealable`
        // — they were never classified this pass; the next pass re-derives
        // every orphan fresh from disk (no tombstone, so a reappearing
        // descriptor is still adopted next time).
        if (wi > 0 && Number.isFinite(c.deadline) && Date.now() >= c.deadline) {
          const deferred = withDescriptorIds.length - wi;
          out.skipped += deferred;
          out.deadlineSkipped += deferred;
          out.detail.push({ action: 'deadline-skip', reason: 'with-descriptor bucket deferred to next pass', count: deferred });
          break;
        }
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
          // SHARED GATE (defect df54edf54804 item 4 parity fix): a bare
          // hasArchivedCounterpart(home, id) only ever catches a DIRECT
          // archived/<id>.json marker for `id` itself — it misses a
          // worktree-group SIBLING (retireArchivedWorktreeGroup tombstones a
          // sibling's registry row but never gives it its own marker or
          // touches its descriptor; see companion/lib/devswarm-archive-gate.js's
          // header). This heal pass is a BULK re-registration path exactly
          // like the store migration, so it shares that same module's
          // decision instead of re-deriving a narrower one: `archived` stays
          // true (never adopt, forward-only below) unless the gate found
          // POSITIVE, current reuse proof.
          const archiveGate = archiveGateLib.resolveArchiveGate(
            home, id, desc, fs, { now: c.now, worktreeIndex: archivedWorktreeIndex }
          );
          const archived = !!(archiveGate.archived && !archiveGate.migrateAsLive);
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
            cursor = floorCursor(s, id, home);
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
                const fwd = forwardArchivedOrphanUnread(s, id, survivor.id, { maxAgeMs, now: c.now, home });
                if (fwd.status !== 'ok') {
                  out.pending++;
                  out.detail.push({ id, action: 'pending', reason: 'survivor-' + fwd.status, survivor: survivor.id });
                  continue;
                }
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
              out.pending++;
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
                  if (r.pending) { out.pending += r.pending; out.detail.push({ id, action: 'pending', reason: (r.skipped[0] && r.skipped[0].reason) || 'skipped', survivor: survivor.id }); }
                  out.detail.push({ id, action: 'adopted', survivor: survivor.id, forwarded: r.forwarded });
                } else {
                  out.detail.push({ id, action: 'adopted', reason: 'no-live-survivor' });
                }
              } else {
                out.detail.push({ id, action: 'adopted' });
              }
            }
          }

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
        out.deadlineSkipped += noDescriptorIds.length;
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
      skipped: 0, pending: 0, errors: 0, detail: [],
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
  let adopted = 0, forwarded = 0, unhealable = 0, archivedDrained = 0, archivedStale = 0, skipped = 0, deadlineSkipped = 0, pending = 0, errors = 0;
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
    deadlineSkipped += r.deadlineSkipped || 0;
    pending += r.pending || 0;
    errors += r.errors || 0;
    if (r.adopted || r.forwarded || r.unhealable || r.archivedDrained || r.archivedStale || r.skipped || r.pending || r.errors) {
      results.push({
        repoKey, ok: true, adopted: r.adopted || 0, forwarded: r.forwarded || 0,
        unhealable: r.unhealable || 0, archivedDrained: r.archivedDrained || 0,
        archivedStale: r.archivedStale || 0, skipped: r.skipped || 0, pending: r.pending || 0, errors: r.errors || 0,
      });
    }
  }
  return {
    ok: true, scope: 'all-stores', stores: hashes.length, adopted, forwarded, unhealable,
    archivedDrained, archivedStale, skipped, deadlineSkipped, pending, errors, results,
  };
}

// importReaderCursorsAllStores(home, ctx) -> { ok, stores, partitions, imported,
//   wouldImport, errors, results }. Phase 3 one-time import (update.js stage
// `reader-cursors-import` + doctor --repair; the lazy first-touch path in
// reader-cursors.js covers anything these never reach). Per partition of every
// store: floor = the legacy effective floor (HEAD's instanceFloor, dry — never
// max'ed with the shared pair), every LIVE harness seeded (mapped legacy
// position or the floor). Idempotent (gated on the '#floor' row, inside the
// txn), fail-open (an error is counted and the next partition proceeds), and
// NO-DELETE (legacy files are only read). ctx.dryRun or ANTIHALL_INGEST_DRY_RUN=1
// -> report only, zero writes.
function importReaderCursorsAllStores(home, ctx) {
  const c = ctx || {};
  const env = c.env || process.env;
  const dryRun = !!c.dryRun || String((env && env.ANTIHALL_INGEST_DRY_RUN) || '') === '1';
  const out = { ok: true, dryRun, stores: 0, partitions: 0, imported: 0, wouldImport: 0, errors: 0, results: [] };
  let hashes = [];
  try { hashes = store.listStoreHashes(home) || []; } catch (_) { hashes = []; }
  let procTable;
  const procThunk = () => {
    if (procTable === undefined) { try { procTable = readerCursors.defaultProcTable(c.now); } catch (_) { procTable = null; } }
    return procTable;
  };
  if (c.procTable !== undefined) procTable = c.procTable;
  for (const repoKey of hashes) {
    let s = null;
    try {
      s = store.openStore({ home, hash: repoKey, backend: c.backend, env, readOnly: dryRun });
    } catch (e) { out.errors++; out.results.push({ repoKey, error: String((e && e.message) || e) }); continue; }
    if (!s) continue;
    out.stores++;
    try {
      let ids = [];
      try { ids = s.listWorkspaceIds() || []; } catch (_) { ids = []; }
      for (const id of ids) {
        if (!isSafeId(id)) continue;
        out.partitions++;
        try {
          let desc = null;
          try { desc = readDescriptorFile(home, id); } catch (_) { desc = null; }
          const r = readerCursors.importLegacy(s, {
            partition: id, home, cursorPath: (desc && desc.cursorPath) || null,
            dryRun, procTable: c.procTable !== undefined ? c.procTable : procThunk, now: c.now,
          });
          if (r.imported) out.imported++;
          if (r.wouldImport) out.wouldImport++;
          // §3 caller 3: mark provably-ended readers (process proof only). This
          // never moves the floor by itself — only the next ack txn does.
          if (!dryRun) {
            const pt = c.procTable !== undefined ? c.procTable : procThunk();
            if (pt instanceof Map) out.retired = (out.retired || 0) + readerCursors.retireEnded(s, { partition: id, procTable: pt, now: c.now }).length;
          }
        } catch (e) {
          out.errors++;
          out.results.push({ repoKey, id, error: String((e && e.message) || e) });
        }
      }
    } finally { try { s.close(); } catch (_) {} }
  }
  return out;
}

// repairReaderFloorsAllStores(home, ctx) -> { ok, dryRun, stores, partitions,
//   pending, repaired, retired, floorsRaised, errors, results }. v0.106.1 repair
// of the floors the v0.106.0 import pinned (update.js stage 'reader-floor-repair'
// + migrations.js 'repair-reader-floors' for doctor --repair; plain doctor
// reports the dry run). Per imported partition of every store:
// reader-cursors.js repairPinnedFloors — retires (never deletes) import-seeded
// rows of non-local/ended sessions, recomputes the floor max-only, repairs a 0
// nd floor from the legacy descriptor cursor. Idempotent, fail-open (an error is
// counted and the next partition proceeds). ctx.dryRun or
// ANTIHALL_INGEST_DRY_RUN=1 -> report only, zero writes.
function repairReaderFloorsAllStores(home, ctx) {
  const c = ctx || {};
  const env = c.env || process.env;
  const dryRun = !!c.dryRun || String((env && env.ANTIHALL_INGEST_DRY_RUN) || '') === '1';
  const out = { ok: true, dryRun, stores: 0, partitions: 0, pending: 0, repaired: 0, retired: 0, floorsRaised: 0, errors: 0, results: [] };
  let hashes = [];
  try { hashes = store.listStoreHashes(home) || []; } catch (_) { hashes = []; }
  let procTable = c.procTable;
  const pt = () => {
    if (procTable === undefined) { try { procTable = readerCursors.defaultProcTable(c.now); } catch (_) { procTable = null; } }
    return procTable;
  };
  for (const repoKey of hashes) {
    let s = null;
    try {
      s = store.openStore({ home, hash: repoKey, backend: c.backend, env, readOnly: dryRun });
    } catch (e) { out.errors++; out.results.push({ repoKey, error: String((e && e.message) || e) }); continue; }
    if (!s) continue;
    out.stores++;
    try {
      let ids = [];
      try { ids = s.listWorkspaceIds() || []; } catch (_) { ids = []; }
      for (const id of ids) {
        if (!isSafeId(id)) continue;
        out.partitions++;
        try {
          const r = readerCursors.repairPinnedFloors(s, { partition: id, home, dryRun, procTable: pt(), kill: c.kill, now: c.now });
          if (!r || !r.changed) continue;
          out.pending++;
          const raised = Object.keys(r.floors || {}).filter((ns) => r.floors[ns].to > r.floors[ns].from).length;
          if (!dryRun) { out.repaired++; out.retired += r.retired.length; out.floorsRaised += raised; }
          out.results.push({ repoKey, id, retired: r.retired, raised: r.raised || [], floors: r.floors });
        } catch (e) {
          out.errors++;
          out.results.push({ repoKey, id, error: String((e && e.message) || e) });
        }
      }
    } finally { try { s.close(); } catch (_) {} }
  }
  return out;
}

// BUILDER_UUID_RE — a DevSwarm builder id (the app's builders.id / DEVSWARM_BUILDER_ID).
const BUILDER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// appDeletedBuilder(appDb, home, env, now, id, worktreePath) -> bool. True only on
// POSITIVE evidence the app deleted builder `id`: the snapshot is readable and
// non-empty, carries no row for `id`, and no ACTIVE builder sits on its worktree.
function appDeletedBuilder(appDb, home, env, now, id, worktreePath) {
  try {
    const snap = appDb.snapshot({ home, env, now });
    if (!snap || !snap.workspaces.length) return false;
    if (snap.workspaces.some((w) => w.id === String(id))) return false;
    return !appDb.workspaceFor(snap, { worktreePath });
  } catch (_) { return false; }
}

// refreshNamesFromApp(home, env, rows, now) -> { appDb, checked, refreshed }.
// v0.108.0: for each { id, worktreePath }, the DevSwarm app's own title for that
// builder (by id; else the ACTIVE builder on that worktree) is written to the
// names cache when it differs from the cached name. Full label, never
// truncated. Fail-open: no app DB -> nothing checked.
function refreshNamesFromApp(home, env, rows, now) {
  const out = { appDb: false, checked: 0, refreshed: 0 };
  let appDb;
  try { appDb = require('../../companion/lib/devswarm-app-db.js'); } catch (_) { return out; }
  const snap = appDb.snapshot({ home, env: env || process.env, now });
  if (!snap) return out;
  out.appDb = true;
  for (const d of rows || []) {
    try {
      if (!d || d.id == null || !isSafeId(String(d.id))) continue;
      const ws = appDb.workspaceFor(snap, { id: d.id, worktreePath: d.worktreePath || null });
      if (!ws || typeof ws.label !== 'string' || !ws.label) continue;
      out.checked++;
      const cached = names.readName(home, String(d.id));
      if (cached === ws.label) continue;
      // SPAWN-TITLE RACE FIX (v0.109.0): `hivecontrol workspace create` gives a
      // brand-new workspace label == the branch name (its own default, see
      // devswarm-names.js header) BEFORE cmdSpawn's SEPARATE `update-title`
      // follow-up call lands (two independent hivecontrol round-trips, by
      // design — see cmdSpawn's "CORRECTED design" comment). This function runs
      // off its own timer (the supervisor's periodic app-DB sync, or a manual
      // `reconcile`) against a snapshot that may itself be up to
      // devswarm-app-db.js's cache window stale, with NO ordering relationship
      // to spawn's two calls — so it can sample exactly that in-between window
      // (or a stale cache predating the retitle) and clobber a title cmdSpawn
      // just confirmed back down to the bare branch name. That produced the
      // observed "sometimes the branch, sometimes the brief" race: whichever
      // writer lands last on names/<id>.json wins, with no rule deciding it.
      // DETERMINISTIC RULE: an app label that is STILL the raw branch name
      // never overwrites an already-cached, DIFFERENT name. A genuine owner
      // rename in the app is never literally the branch string (nobody renames
      // a workspace to its own branch name), so this only ever protects a
      // spawn-set title from the race — a real rename still propagates below.
      if (cached && ws.branchName && ws.label === ws.branchName) continue;
      if (names.writeName(home, String(d.id), ws.label, now)) out.refreshed++;
    } catch (_) { /* one bad row never stops the rest */ }
  }
  return out;
}

// appStatePath(home) -> <devswarm>/app-state.json — the supervisor's last app-DB
// sync: summary, session map, drift and message-gap report. Counts, ids, titles
// and timestamps only — never message bodies, brief text or credentials.
function appStatePath(home) { return path.join(devswarmRoot(home), 'app-state.json'); }

function readJsonDescriptors(dir) {
  const out = [];
  let ns = [];
  try { ns = fs.readdirSync(dir); } catch (_) { return out; }
  for (const n of ns) {
    if (!n.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (d && typeof d === 'object' && !Array.isArray(d)) out.push(Object.assign({ id: n.slice(0, -5) }, d));
    } catch (_) { /* skip torn */ }
  }
  return out;
}

// messageGaps(home, env, snap, now) -> { repos: [...] } | null. v0.108.0
// message-loss cross-check (REPORT-ONLY). For each app repository whose mesh
// store exists: every app workspace_messages row (repositoryId, toBranch,
// createdAt — never the body) is matched against the store's native-ingested
// rows by timestamp (the ingest daemon stores the app's createdAt as `ts`;
// verified exact on a live pair). Unmatched rows are split into: archived
// target (excluded — nobody will ever read them), before ingest began (history),
// and GAP (a live target, after ingest started) with per-branch + age buckets.
const MESSAGE_SETTLE_MS = 2 * 60 * 1000;
function messageGaps(home, env, snap, now) {
  let appDb;
  try { appDb = require('../../companion/lib/devswarm-app-db.js'); } catch (_) { return null; }
  if (!snap) return null;
  const t = Number.isFinite(now) ? now : Date.now();
  const byRepo = appDb.messageTimestamps({ home, env, sinceMs: 0, untilMs: t - MESSAGE_SETTLE_MS });
  if (!byRepo) return null;
  let sqlite;
  try { sqlite = require('../../companion/lib/sqlite-quiet.js').requireSqlite(); } catch (_) { return null; }
  const repos = [];
  for (const repo of snap.repositories) {
    const rows = byRepo.get(repo.id) || [];
    const r = { repositoryId: repo.id, name: repo.name, repoKey: null, app: rows.length, matched: 0, archivedTarget: 0, preIngest: 0, gap: 0, byBranch: {} };
    if (!rows.length) { repos.push(r); continue; }
    try { r.repoKey = repo.path ? repokey.repoKeyForWorktreeFast(repo.path) : null; } catch (_) { r.repoKey = null; }
    const dbFile = r.repoKey ? store.sqlitePathForHash(home, r.repoKey) : null;
    if (!dbFile || !fs.existsSync(dbFile)) { r.reason = 'no-store'; repos.push(r); continue; }
    let db = null;
    let tsSet;
    try {
      db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
      tsSet = new Set(db.prepare("SELECT ts FROM messages WHERE hash LIKE 'native:%'").all().map((x) => Number(x.ts)));
    } catch (e) { r.reason = 'store-unreadable'; repos.push(r); continue; } finally { try { if (db) db.close(); } catch (_) {} }
    let ingestStart = Infinity;
    for (const v of tsSet) if (v < ingestStart) ingestStart = v;
    const liveBranches = new Set(snap.workspaces.filter((w) => w.repositoryId === repo.id && !w.archived && w.branchName).map((w) => w.branchName));
    for (const m of rows) {
      if (m.createdAtMs != null && tsSet.has(m.createdAtMs)) { r.matched++; continue; }
      if (!liveBranches.has(m.toBranch)) { r.archivedTarget++; continue; }
      if (m.createdAtMs == null || m.createdAtMs < ingestStart) { r.preIngest++; continue; }
      r.gap++;
      const b = r.byBranch[m.toBranch] || (r.byBranch[m.toBranch] = { n: 0, oldest: null, newest: null, lt1h: 0, lt1d: 0, lt7d: 0, older: 0 });
      b.n++;
      b.oldest = b.oldest == null ? m.createdAtMs : Math.min(b.oldest, m.createdAtMs);
      b.newest = b.newest == null ? m.createdAtMs : Math.max(b.newest, m.createdAtMs);
      const age = t - m.createdAtMs;
      if (age < 3600e3) b.lt1h++; else if (age < 864e5) b.lt1d++; else if (age < 7 * 864e5) b.lt7d++; else b.older++;
    }
    r.ingestStart = Number.isFinite(ingestStart) ? ingestStart : null;
    repos.push(r);
  }
  return { at: t, repos };
}

// syncAppState(home, ctx) -> result. v0.108.0 RUNNER step (the supervisor sweep
// calls this every tick; also `devswarm.js app-sync`). ONE fresh snapshot, then:
//   (1) markAppArchivedDescriptors — archived / deleted-in-app markers (never a delete)
//   (1b) retireStaleArchivedMarkers — markers the app shows OPEN are retired (never a delete)
//   (2) refreshNamesFromApp — names cache follows the app's title
//   (3) app-state.json (atomic): summary, session map (active AI terminals),
//       builders active in the app that anti-hall has no descriptor for, schema
//       drift, pending app deletions
//   (4) messageGaps — at most every ctx.gapCooldownMs (default 15 min)
// ctx.dryRun / ANTIHALL_INGEST_DRY_RUN=1 -> computes, writes nothing. Never throws.
const APP_GAP_COOLDOWN_MS = 15 * 60 * 1000;
function syncAppState(home, ctx) {
  const c = ctx || {};
  const env = c.env || process.env;
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  const started = Date.now();
  const dryRun = !!c.dryRun || String((env && env.ANTIHALL_INGEST_DRY_RUN) || '') === '1';
  const out = { ok: true, dryRun, appDb: false };
  try {
    const appDb = require('../../companion/lib/devswarm-app-db.js');
    const snap = appDb.snapshot({ home, env, now, fresh: true });
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(appStatePath(home), 'utf8')); } catch (_) { prev = null; }
    if (!snap) {
      out.reason = 'app-db-unavailable';
      if (!dryRun) writeAtomicJson(appStatePath(home), { v: 1, at: now, ok: false, reason: out.reason });
      out.elapsedMs = Date.now() - started;
      return out;
    }
    out.appDb = true;
    const archived = markAppArchivedDescriptors(home, { env, now, dryRun });
    out.archived = { marked: archived.marked, pending: archived.pending, deletedInApp: archived.deletedInApp || 0, errors: archived.errors };
    // v0.108.3: a marker the app DB shows OPEN is stale -> retired (never deleted),
    // BEFORE the archived set below is read, so it stops reporting as a conflict.
    const retiredMarkers = retireStaleArchivedMarkers(home, { env, now, dryRun, snap });
    out.retiredMarkers = { retired: retiredMarkers.retired, pending: retiredMarkers.pending, errors: retiredMarkers.errors };
    const descs = readJsonDescriptors(workspacesDir(home));
    const archivedDescs = readJsonDescriptors(archivedDir(home));
    const namesRes = dryRun ? { checked: 0, refreshed: 0 } : refreshNamesFromApp(home, env, descs.concat(archivedDescs), now);
    out.names = { checked: namesRes.checked, refreshed: namesRes.refreshed };
    const known = new Set(descs.concat(archivedDescs).map((d) => String(d.id)));
    const archivedIds = new Set(archivedDescs.map((d) => String(d.id)));
    const openButMarkedArchived = [];
    const knownWt = new Set(descs.concat(archivedDescs).map((d) => (d.worktreePath ? (canonicalWorktreeRealPath(String(d.worktreePath)) || String(d.worktreePath)) : null)).filter(Boolean));
    const focused = appDb.focusedWorkspaceId(snap, now);
    const sessions = {};
    const active = [];
    const unknownToAntiHall = [];
    for (const w of snap.workspaces) {
      if (!w.active) continue;
      const cur = w.terminals.filter((t) => t.terminalType === 'ai' && t.isActive === true && t.sessionId)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
      if (cur) {
        const corroborated = appDb.transcriptCwdMatches(home, cur.sessionId, w.worktreePathRaw || w.worktreePath) === true;
        sessions[cur.sessionId] = { builderId: w.id, worktreePath: w.worktreePath, builderType: w.builderType, corroborated };
      }
      const brief = appDb.briefDelivery(snap, w, now);
      active.push({
        id: w.id, label: w.label, builderType: w.builderType, repositoryId: w.repositoryId, rank: w.rank, isPinned: w.isPinned,
        focused: w.id === focused, finish: appDb.finishSignal(w), brief: brief ? brief.status : null,
        sessionId: cur ? cur.sessionId : null, panelStatus: cur ? cur.panelStatus : null,
        scrollbackMtimeMs: w.scrollback ? w.scrollback.mtimeMs : null,
      });
      const wtKey = w.worktreePath ? (canonicalWorktreeRealPath(w.worktreePath) || w.worktreePath) : null;
      if (w.builderType !== 'primary' && !known.has(w.id) && !(wtKey && knownWt.has(wtKey))) unknownToAntiHall.push({ id: w.id, label: w.label });
      // Open in the app, but anti-hall still holds an archived marker for it
      // (dry run, inside the retire grace, a restore/retire that failed, or a
      // local `archive` the owner has not yet done in the app — never
      // auto-restored). The app is never touched; retireStaleArchivedMarkers
      // above retires (and restores) the marker when it qualifies.
      // repositoryId AND the canonicalized worktreePath (wtKey, already computed
      // above) are stamped so readers can scope conflicts to the current repo
      // (P1 fix, same scoping as doctor-devswarm.js). worktreePath is the
      // structural signal (matches D29's cross-project filter design — a
      // worktree-root comparison, not the app-DB's own repositoryId) that
      // devswarm-parent-inbox.js relies on, since it must scope even when the
      // app DB itself is unreadable (no live snapshot to resolve repositoryId
      // against at ask-time).
      if (archivedIds.has(w.id)) {
        const marker = archivedDescs.find((d) => String(d.id) === String(w.id));
        // localArchive: anti-hall's OWN `archive` verb wrote the marker (never app-sourced) — the
        // owner-visible "app still shows a workspace you archived" case; `cmd` is the exact fix.
        const localArchive = !!marker && !APP_SOURCED_MARKERS.has(marker.archivedBy) && w.builderType !== 'primary';
        openButMarkedArchived.push({
          id: w.id, label: w.label, repositoryId: w.repositoryId, worktreePath: wtKey,
          localArchive, cmd: localArchive ? 'hivecontrol workspace archive ' + (w.branchName || w.id) : null,
        });
      }
    }
    active.sort((a, b) => (a.repositoryId || '').localeCompare(b.repositoryId || '') || ((a.rank == null ? Infinity : a.rank) - (b.rank == null ? Infinity : b.rank)));
    const gapCooldown = Number.isFinite(c.gapCooldownMs) ? c.gapCooldownMs : APP_GAP_COOLDOWN_MS;
    let gaps = prev && prev.gaps ? prev.gaps : null;
    if (!gaps || !Number.isFinite(gaps.at) || now - gaps.at >= gapCooldown || now < gaps.at) {
      gaps = messageGaps(home, env, snap, now);
      out.gapsScanned = true;
    }
    const state = {
      v: 1, at: now, ok: true, appVersion: snap.appVersion, missing: snap.missing, gated: snap.gated || [],
      counts: { builders: snap.workspaces.length, active: active.length, archived: snap.workspaces.filter((w) => w.archived).length },
      focused, active, sessions, unknownToAntiHall, openButMarkedArchived,
      scheduledForDeletion: appDb.scheduledForDeletion(home, env) || [],
      archived: out.archived, retiredMarkers: out.retiredMarkers, names: out.names, gaps,
    };
    out.unknownToAntiHall = unknownToAntiHall.length;
    out.gapTotal = gaps ? gaps.repos.reduce((n, r) => n + r.gap, 0) : null;
    out.missing = snap.missing.length;
    if (!dryRun) writeAtomicJson(appStatePath(home), state);
    out.state = state;
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e);
  }
  out.elapsedMs = Date.now() - started;
  return out;
}

function writeAtomicJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

// cmdAppState(flags, ctx) — `devswarm.js app-state [--json]`. READ-ONLY: a fresh
// snapshot summary (computed, never written) plus the last supervisor sync's
// gap report / drift from app-state.json. No bodies, no brief text, no credentials.
function cmdAppState(flags, ctx) {
  const home = ctx.home;
  const r = syncAppState(home, { env: ctx.env, now: ctx.now, dryRun: true, gapCooldownMs: Infinity });
  let last = null;
  try { last = JSON.parse(fs.readFileSync(appStatePath(home), 'utf8')); } catch (_) { last = null; }
  const st = r.state || null;
  const result = {
    ok: r.ok !== false, action: 'app-state', appDb: r.appDb, reason: r.reason || null,
    appVersion: st ? st.appVersion : null, missing: st ? st.missing : [], gated: st ? st.gated : [],
    counts: st ? st.counts : null, focused: st ? st.focused : null, active: st ? st.active : [],
    sessions: st ? st.sessions : {}, unknownToAntiHall: st ? st.unknownToAntiHall : [],
    openButMarkedArchived: st ? st.openButMarkedArchived : [],
    gaps: (last && last.gaps) || (st && st.gaps) || null,
    scheduledForDeletion: st ? st.scheduledForDeletion : [], wouldMark: r.archived ? r.archived.pending : 0,
    lastSync: last ? { at: last.at, ok: last.ok, gaps: last.gaps || null, archived: last.archived || null, names: last.names || null } : null,
  };
  if (!(flags && flags.json && flags.json.length)) result.text = formatAppState(result);
  return result;
}

function formatAppState(r) {
  if (!r.appDb) return 'DevSwarm app DB: unavailable (' + (r.reason || 'no app DB') + ') — nothing to show.';
  const L = [];
  L.push('DevSwarm app DB ' + (r.appVersion || '(version unknown)') + ' — ' + r.counts.builders + ' builders, ' + r.counts.active + ' open, ' + r.counts.archived + ' archived');
  if (r.missing.length) L.push('⚠ DevSwarm app schema changed: ' + r.missing.join(', '));
  if (r.gated.length) L.push('capability-gated (dormant): ' + r.gated.join(', '));
  L.push('| rank | workspace | type | finish | brief | session |');
  L.push('|---|---|---|---|---|---|');
  for (const a of r.active) {
    const title = (a.label || a.id).replace(/\|/g, '\\|') + ' (' + String(a.id).slice(0, 8) + ')' + (a.isPinned ? ' [pinned]' : '') + (a.focused ? ' [on screen]' : '');
    const sess = a.sessionId ? String(a.sessionId).slice(0, 8) + ((r.sessions[a.sessionId] || {}).corroborated ? '' : ' (unverified)') : '—';
    L.push('| ' + (a.rank == null ? '—' : a.rank) + ' | ' + title + ' | ' + (a.builderType || '—') + ' | ' + (a.finish || '—') + ' | ' + (a.brief || '—') + ' | ' + sess + ' |');
  }
  if (r.unknownToAntiHall.length) L.push('open in the app, unknown to anti-hall: ' + r.unknownToAntiHall.map((u) => (u.label || u.id) + ' (' + String(u.id).slice(0, 8) + ')').join('; '));
  if (r.openButMarkedArchived.length) L.push('⚠ open in the app but archived in anti-hall (stale marker — the app is right; the next app-DB sync retires it): ' + r.openButMarkedArchived.map((u) => (u.label || u.id) + ' (' + String(u.id).slice(0, 8) + ')').join('; '));
  if (r.wouldMark) L.push('next sync marks ' + r.wouldMark + ' descriptor(s) archived (app-archived or deleted in the app)');
  if (r.scheduledForDeletion.length) L.push('pending app deletion (report only): ' + r.scheduledForDeletion.join(', '));
  const g = r.gaps;
  if (g) {
    for (const repo of g.repos) {
      if (!repo.app) continue;
      L.push('messages ' + (repo.name || repo.repositoryId) + ': app ' + repo.app + ', ingested ' + repo.matched + ', to archived targets ' + repo.archivedTarget
        + ', before ingest ' + repo.preIngest + ', GAP ' + repo.gap + (repo.reason ? ' (' + repo.reason + ')' : ''));
      for (const [b, v] of Object.entries(repo.byBranch || {})) L.push('  gap → ' + b + ': ' + v.n + ' (<1h ' + v.lt1h + ', <1d ' + v.lt1d + ', <7d ' + v.lt7d + ', older ' + v.older + ')');
    }
  } else {
    L.push('message gap report: no supervisor sync yet');
  }
  return L.join('\n');
}

// cmdSyncUi(flags, ctx) — `devswarm.js sync-ui --titles-json <file> | --stdin
// [--yes] [--no-repair] [--accept-conflicts]` (v0.108.0, screenshot sync). The
// owner's transcribed sidebar titles (top-to-bottom, "…" kept verbatim) are
// planned against the app DB + anti-hall's records by companion/lib/
// devswarm-ui-sync.js (all safety rules live there). DRY RUN by default: prints
// the plan + a before table. --yes applies it: archived markers for `toArchive`
// (app-DB-proven only; never a delete) and — unless --no-repair — the names
// cache for `titleUpdates` (the app's FULL label). Conflicts refuse --yes unless
// --accept-conflicts (the skill asks the owner first). Returns { plan, before,
// after, diff }.
function cmdSyncUi(flags, ctx) {
  const home = ctx.home;
  const env = ctx.env || process.env;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  // Setting devswarm.screenshotSync (0.108.4): off -> refuse, change nothing.
  let screenshotSyncOn = true;
  try { screenshotSyncOn = require('../../hooks/lib/settings.js').get('devswarm', 'screenshotSync', true, { env, home }) !== false; } catch (_) { screenshotSyncOn = true; }
  if (!screenshotSyncOn) return { ok: false, action: 'sync-ui', disabled: true, error: 'screenshot sync is off (setting devswarm.screenshotSync=false); turn it on with /anti-hall:settings' };
  let raw = null;
  const file = one(flags, 'titles-json');
  try {
    if (file) raw = fs.readFileSync(String(file), 'utf8');
    else if (hasFlag(flags, 'stdin')) raw = (ctx.io && typeof ctx.io.readStdin === 'function') ? ctx.io.readStdin() : fs.readFileSync(0, 'utf8');
  } catch (e) { return { ok: false, action: 'sync-ui', error: 'cannot read titles: ' + String((e && e.message) || e) }; }
  if (raw == null) return { ok: false, action: 'sync-ui', error: 'sync-ui needs --titles-json <file> or --stdin (a JSON array of sidebar titles, top-to-bottom)' };
  let titles;
  try {
    const v = JSON.parse(raw);
    titles = Array.isArray(v) ? v : (v && Array.isArray(v.titles) ? v.titles : null);
  } catch (_) { titles = null; }
  if (!titles || !titles.every((t) => typeof t === 'string')) return { ok: false, action: 'sync-ui', error: 'titles must be a JSON array of strings (or {"titles": [...]})' };
  const uiSync = require('../../companion/lib/devswarm-ui-sync.js');
  const appDb = require('../../companion/lib/devswarm-app-db.js');
  const gather = () => {
    const snap = appDb.snapshot({ home, env, now, fresh: true });
    let repositoryId = null;
    try {
      const main = inst.resolveMainWorktree(ctx.cwd || process.cwd()) || ctx.cwd || process.cwd();
      const repo = appDb.repositoryForWorktree(snap, main);
      repositoryId = repo ? repo.id : null;
    } catch (_) { repositoryId = null; }
    const descriptors = readJsonDescriptors(workspacesDir(home));
    const markers = readJsonDescriptors(archivedDir(home)).map((d) => String(d.id));
    const nm = {};
    if (snap) for (const w of snap.workspaces) { const n = names.readName(home, w.id); if (n) nm[w.id] = n; }
    const plan = uiSync.planUiSync({ titles, snapshot: snap, repositoryId, descriptors, markers, names: nm });
    const table = snap ? snap.workspaces.filter((w) => w.builderType !== 'primary' && (!repositoryId || w.repositoryId === repositoryId) && (w.active || descriptors.some((d) => String(d.id) === w.id)))
      .sort((a, b) => ((a.rank == null ? Infinity : a.rank) - (b.rank == null ? Infinity : b.rank)))
      .map((w) => ({ id: w.id, title: w.label, app: w.archived ? 'archived' : (w.active ? 'open' : 'closed'), antiHall: markers.includes(w.id) ? 'archived' : (descriptors.some((d) => String(d.id) === w.id) ? 'active' : '—'), cachedName: nm[w.id] || null })) : [];
    return { snap, repositoryId, plan, table, descriptors };
  };
  const before = gather();
  const out = { ok: true, action: 'sync-ui', dryRun: !hasFlag(flags, 'yes'), appDb: !!before.snap, repositoryId: before.repositoryId, plan: before.plan, before: before.table };
  if (out.dryRun) return out;
  if (before.plan.conflicts.length && !hasFlag(flags, 'accept-conflicts')) {
    return Object.assign(out, { ok: false, reason: 'conflicts', error: before.plan.conflicts.length + ' conflict(s) — confirm with the owner, then re-run with --accept-conflicts' });
  }
  const diff = { archived: [], renamed: [], errors: [] };
  for (const t of before.plan.toArchive) {
    try {
      const desc = before.descriptors.find((d) => String(d.id) === t.id);
      if (!desc || !isSafeId(t.id)) continue;
      const dir = checkedArchivedDir(home, { create: true });
      if (!dir.ok) throw new Error(dir.error || 'archived dir unusable');
      const body = JSON.stringify(Object.assign({}, desc, { archivedBy: 'devswarm-ui-sync', archivedAt: now }));
      try { fs.writeFileSync(path.join(archivedDir(home), t.id + '.json'), body, { flag: 'wx' }); diff.archived.push(t.id); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
    } catch (e) { diff.errors.push({ id: t.id, error: String((e && e.message) || e) }); }
  }
  if (!hasFlag(flags, 'no-repair')) {
    for (const u of before.plan.titleUpdates) if (isSafeId(u.id) && names.writeName(home, u.id, u.to, now)) diff.renamed.push(u.id);
  }
  const after = gather();
  return Object.assign(out, { after: after.table, afterPlan: after.plan, diff });
}

// markAppArchivedDescriptors(home, ctx) -> { ok, dryRun, appDb, scanned,
//   pending, marked, errors, results }. v0.107.1 repair for workspaces archived
// in the DevSwarm APP: the app's builders table (companion/lib/devswarm-app-db.js)
// says archived, but anti-hall never learned it (app archive never writes
// archived/<id>.json, and `hivecontrol workspace list all` still lists archived
// builders, so the absence rule never fired). For every ACTIVE descriptor
// (workspaces/<id>.json) the app DB proves archived — by id, or a twin row on an
// archived worktree with no active builder — writes the existing archived
// marker archived/<id>.json (the descriptor's own content + archivedBy /
// archivedAt). NEVER-CLOBBER (exclusive create: an existing marker is left
// as-is), NO-DELETE (the descriptor is never touched), idempotent, fail-open
// (no app DB -> nothing to do; an error is counted). ctx.dryRun or
// ANTIHALL_INGEST_DRY_RUN=1 -> report only.
function markAppArchivedDescriptors(home, ctx) {
  const c = ctx || {};
  const env = c.env || process.env;
  const dryRun = !!c.dryRun || String((env && env.ANTIHALL_INGEST_DRY_RUN) || '') === '1';
  const out = { ok: true, dryRun, appDb: false, scanned: 0, pending: 0, marked: 0, errors: 0, results: [] };
  let appDb;
  try { appDb = require('../../companion/lib/devswarm-app-db.js'); } catch (_) { return out; }
  if (!appDb.builderStates({ home, env, now: c.now })) return out; // no app DB: no evidence
  out.appDb = true;
  let names = [];
  try { names = fs.readdirSync(workspacesDir(home)); } catch (_) { names = []; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -'.json'.length);
    if (!isSafeId(id)) continue;
    out.scanned++;
    try {
      let desc;
      try { desc = JSON.parse(fs.readFileSync(path.join(workspacesDir(home), n), 'utf8')); } catch (_) { continue; }
      if (!desc || typeof desc !== 'object' || Array.isArray(desc)) continue;
      const verdict = appDb.appArchivedVerdict({ home, env, id, worktreePath: desc.worktreePath || null, now: c.now });
      // v0.108.0: DELETED in the app — the app removes the builder row on delete
      // (its terminals cascade). A builder-UUID descriptor with no row left and
      // no active builder on its worktree is gone for good: tombstone it with
      // the same archived marker (never a delete; `unarchive` reverses it).
      const deleted = verdict === null && BUILDER_UUID_RE.test(id) && appDeletedBuilder(appDb, home, env, c.now, id, desc.worktreePath || null);
      if (verdict !== true && !deleted) continue;
      const marker = path.join(archivedDir(home), id + '.json');
      if (fs.existsSync(marker)) continue;
      out.pending++;
      if (dryRun) { out.results.push({ id, action: 'would-mark' }); continue; }
      const dir = checkedArchivedDir(home, { create: true });
      if (!dir.ok) throw new Error(dir.error || 'archived dir unusable');
      const body = JSON.stringify(Object.assign({}, desc, { archivedBy: deleted ? 'devswarm-app-deleted' : 'devswarm-app', archivedAt: Number.isFinite(c.now) ? c.now : Date.now() }));
      try { fs.writeFileSync(marker, body, { flag: 'wx' }); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; continue; }
      out.marked++;
      if (deleted) out.deletedInApp = (out.deletedInApp || 0) + 1;
      out.results.push({ id, action: deleted ? 'marked-deleted-in-app' : 'marked' });
    } catch (e) {
      out.errors++;
      out.results.push({ id, error: String((e && e.message) || e) });
    }
  }
  if (!dryRun) out.pending = Math.max(0, out.pending - out.marked);
  return out;
}

// retireStaleArchivedMarkers(home, ctx) -> { ok, dryRun, appDb, scanned,
//   pending, retired, left[], localHeld[], errors, results }. v0.108.3 (owner
// decision "retire marker, trust app"): an archived/<id>.json marker whose
// workspace the READABLE app DB shows OPEN (isActive=1 AND isHidden=0, same
// builder id, same worktree when both are known) is stale — the app is the
// ground truth. Trusting the app means the workspace becomes ACTIVE again:
// restoreArchivedDescriptor (the same restore cmdUnarchive runs) puts the
// descriptor back in workspaces/ when it is missing and revives the registry
// row, and ONLY THEN is the marker retired — renamed out of archived/ into
// archived-retired/<id>.<ms>.json and re-written there (tmp+rename, so a
// hardlinked active descriptor is never touched) with a `retired` record
// { at, by, reason, restored }. Never deleted. A restore that fails leaves the
// marker in archived/ (reported in `left`): the marker is then still the one
// copy of the descriptor, so the workspace is never orphaned in neither dir.
// Which markers qualify (P1-A):
//   - Only markers anti-hall wrote FROM app evidence (archivedBy in
//     APP_SOURCED_MARKERS). The app then showed the workspace archived/absent;
//     open now means the owner reopened it there, so the app is new evidence.
//   - A marker from anti-hall's OWN `archive` verb (no archivedBy: cmdArchive,
//     reap-stale, the archive sweep) is NEVER auto-restored, at any age. That
//     verb archives locally and tells the owner to archive in the app; until
//     they do, "open in the app" is the EXPECTED pending state, not evidence the
//     owner changed their mind — the app DB keeps no history that could tell
//     "not archived yet" from "reopened", so any timer (10 min or 10 days)
//     would guess, and a wrong guess silently undoes an explicit owner archive
//     (and fights the sweep). Keeping it archived is reversible (`unarchive`)
//     and loses nothing; it is reported in `localHeld` and app-state's
//     openButMarkedArchived.
//   - An app-sourced marker younger than RETIRE_MARKER_GRACE_MS (by its
//     archivedAt) is left alone, so one transient app-DB read cannot flap it.
// Under the per-id lock; idempotent (a retired marker is gone from archived/,
// and a restore of an already-active workspace is a no-op); fail-open (no /
// unreadable app DB -> nothing to do, errors are counted). ctx.snap reuses a
// caller's fresh snapshot; ctx.dryRun or ANTIHALL_INGEST_DRY_RUN=1 -> report only.
const RETIRE_MARKER_GRACE_MS = 10 * 60 * 1000;
const APP_SOURCED_MARKERS = new Set(['devswarm-app', 'devswarm-app-deleted', 'devswarm-ui-sync']);
function retireStaleArchivedMarkers(home, ctx) {
  const c = ctx || {};
  const env = c.env || process.env;
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  const dryRun = !!c.dryRun || String((env && env.ANTIHALL_INGEST_DRY_RUN) || '') === '1';
  const out = { ok: true, dryRun, appDb: false, scanned: 0, pending: 0, retired: 0, left: [], localHeld: [], errors: 0, results: [] };
  let snap = c.snap || null;
  try { if (!snap) snap = require('../../companion/lib/devswarm-app-db.js').snapshot({ home, env, now, fresh: true }); } catch (_) { snap = null; }
  if (!snap || !Array.isArray(snap.workspaces)) return out; // unreadable: no evidence, retire nothing
  out.appDb = true;
  const open = new Map();
  for (const w of snap.workspaces) if (w && w.active === true && w.isHidden === false) open.set(String(w.id), w);
  const dirState = checkedArchivedDir(home);
  if (!dirState.ok || !dirState.exists) return out;
  let names = [];
  try { names = fs.readdirSync(dirState.path); } catch (_) { names = []; }
  const wtKey = (p) => (p ? (canonicalWorktreeRealPath(String(p)) || String(p)) : null);
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -'.json'.length);
    if (!isSafeId(id)) continue;
    out.scanned++;
    const w = open.get(id);
    if (!w) continue;
    const markerPath = path.join(dirState.path, n);
    try {
      let marker;
      try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch (_) { continue; }
      if (!marker || typeof marker !== 'object' || Array.isArray(marker)) continue;
      const mw = wtKey(marker.worktreePath);
      const aw = wtKey(w.worktreePath);
      if (mw && aw && mw !== aw) continue; // a reused id on another worktree: not this workspace's marker
      if (!APP_SOURCED_MARKERS.has(marker.archivedBy)) { out.localHeld.push(id); continue; }
      const markedAt = Number.isFinite(marker.archivedAt) ? marker.archivedAt : fs.lstatSync(markerPath).ctimeMs;
      if (now - markedAt < RETIRE_MARKER_GRACE_MS) continue;
      out.pending++;
      if (dryRun) { out.results.push({ id, action: 'would-retire' }); continue; }
      const r = withIdLock(id, home, () => {
        if (!fs.existsSync(markerPath)) return { ok: false, reason: 'marker-gone' };
        // Restore FIRST (same logic as cmdUnarchive); the marker moves only
        // after the workspace is verifiably active again.
        const restored = restoreArchivedDescriptor(home, id, { home, env, backend: c.backend }, { keepMarker: true });
        if (!restored.ok) return { ok: false, reason: 'restore-failed: ' + restored.error };
        const dir = retiredMarkersDir(home);
        fs.mkdirSync(dir, { recursive: true });
        const st = fs.lstatSync(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, reason: 'retired dir is not a real directory' };
        const dest = path.join(dir, id + '.' + now + '.json');
        if (fs.existsSync(dest)) return { ok: false, reason: 'retired-exists' };
        const body = fs.readFileSync(markerPath, 'utf8');
        fs.renameSync(markerPath, dest); // leave archived/ first; bytes kept
        let prior = {};
        try { prior = JSON.parse(body); } catch (_) { prior = { raw: body }; }
        const rec = Object.assign({}, prior, {
          retired: { at: now, by: 'devswarm-app-sync', reason: 'open in the DevSwarm app (isActive=1, isHidden=0); workspace restored to active', builderId: String(w.id), restored: true },
        });
        const tmp = dest + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(rec));
        fs.renameSync(tmp, dest); // new inode: a hardlinked active descriptor is never rewritten
        return { ok: true, to: dest };
      });
      if (r && r.ok) { out.retired++; out.results.push({ id, action: 'retired', to: r.to }); }
      else if (r && r.reason === 'marker-gone') { out.pending--; }
      else { out.left.push({ id, reason: r && r.lockBusy ? 'lock-busy' : ((r && r.reason) || 'retire-failed') }); }
    } catch (e) {
      out.errors++;
      out.results.push({ id, error: String((e && e.message) || e) });
    }
  }
  if (!dryRun) out.pending = Math.max(0, out.pending - out.retired);
  return out;
}

// reconcileDualPartitionAcks(home, ctx) — FORWARD-MIGRATION for the
// dual-partition defect (see declaredSelfId). Before the fix, one identity's
// two partitions — a worktree's anchor row (id === its canonical meshId,
// `primary-<hash>`) and the DEVSWARM_BUILDER_ID row on the SAME worktree — held
// the same message (a fold forward: the copy's origHash names the original)
// but only the partition the reader acked moved; the other kept it unread.
//
// For every such anchor/partner pair: walk a partition from its floor and
// raise it through the CONTIGUOUS prefix of rows whose exact message (hash,
// or the origHash link of a forward — recipient-bound, never text) sits BELOW the other
// partition's floor — i.e. already consumed by every reader there. Stops at
// the first row that is not, so no row that is unacked elsewhere is ever
// skipped. MAX-only (raiseAllLossFree, the fold's own loss-free raise), no
// delete, idempotent (a second run finds nothing past the floor to match).
// Pairs of two NON-anchor rows (two live children on one worktree) are never
// touched, and the anchor pairs ONLY with a row carrying no session or the
// anchor's own session — the same identity test siblingAckGate applies — so a
// child registered on the Primary's worktree is never reconciled. dryRun (or ANTIHALL_INGEST_DRY_RUN=1) counts only. Fail-open: a
// per-store error is counted, never thrown.
// -> { ok, dryRun, stores, pairs, partitions, raised, wouldRaise, rows, errors, results[] }
function reconcileDualPartitionAcks(s, home, dryRun, out) {
  const registry = s.listRegistry() || [];
  const groups = new Map();
  for (const d of registry) {
    if (!d || !d.worktreePath || !isSafeId(String(d.id))) continue;
    let key = null;
    try { key = canonicalMeshId(d.worktreePath); } catch (_) { key = null; }
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(String(d.id));
  }
  const sidOf = new Map(registry.filter((d) => d && d.id != null).map((d) => [String(d.id), d.sessionId != null ? String(d.sessionId) : '']));
  for (const [meshId, ids] of groups) {
    if (ids.length < 2 || ids.indexOf(meshId) === -1) continue;
    const view = new Map(); // id -> { floor, rows, consumed:Set }
    for (const id of ids) {
      const rows = s.listMessages(id) || [];
      const floor = floorCursor(s, id, home);
      const consumed = new Set();
      for (let i = 0; i < Math.min(floor, rows.length); i++) {
        for (const k of [rows[i].hash, forwardedOrigHashOf(rows[i])]) if (k) consumed.add(String(k));
      }
      view.set(id, { floor, rows, consumed });
    }
    const anchorSid = sidOf.get(meshId) || '';
    const sameIdentity = (id) => { const sid = sidOf.get(id) || ''; return sid === '' || sid === anchorSid; };
    const pairOf = (a, b) => (a === meshId && sameIdentity(b)) || (b === meshId && sameIdentity(a));
    for (const id of ids) {
      const me = view.get(id);
      const others = ids.filter((o) => o !== id && pairOf(id, o)).map((o) => view.get(o));
      if (!others.length) continue;
      out.pairs++;
      const ackedElsewhere = (row) => {
        const keys = [row.hash, forwardedOrigHashOf(row)].filter(Boolean).map(String);
        return others.some((o) => keys.some((k) => o.consumed.has(k)));
      };
      let to = me.floor;
      while (to < me.rows.length && ackedElsewhere(me.rows[to])) to++;
      if (to <= me.floor) continue;
      out.partitions++;
      out.rows += to - me.floor;
      if (dryRun) { out.wouldRaise++; out.results.push({ id, from: me.floor, to, dryRun: true }); continue; }
      readerCursors.raiseAllLossFree(s, { partition: id, ns: 'store', value: to, home });
      try { logCursorWrite(home, { id, partition: id, ns: 'reader_cursors:store', from: me.floor, to, delivered: null, gate: 'dual-partition-reconcile', verb: 'migrate', cwd: null, repoKey: null }); } catch (_) {}
      out.raised++;
      out.results.push({ id, from: me.floor, to });
    }
  }
}
function reconcileDualPartitionAcksAllStores(home, ctx) {
  const c = ctx || {};
  const env = c.env || process.env;
  const dryRun = !!c.dryRun || String((env && env.ANTIHALL_INGEST_DRY_RUN) || '') === '1';
  const out = { ok: true, dryRun, stores: 0, pairs: 0, partitions: 0, raised: 0, wouldRaise: 0, rows: 0, errors: 0, results: [] };
  let hashes = [];
  try { hashes = store.listStoreHashes(home) || []; } catch (_) { hashes = []; }
  for (const repoKey of hashes) {
    let s = null;
    try {
      s = store.openStore({ home, hash: repoKey, backend: c.backend, env, readOnly: dryRun });
      if (!s) continue;
      out.stores++;
      reconcileDualPartitionAcks(s, home, dryRun, out);
    } catch (e) {
      out.errors++;
      out.results.push({ repoKey, error: String((e && e.message) || e) });
    } finally { if (s) { try { s.close(); } catch (_) {} } }
  }
  return out;
}

// repairChildSenderLabelsAllStores(home, ctx) -> { ok, dryRun, stores, labels,
//   pending, aliased, retired, forwarded, left[], errors, results[] }.
// v0.108.0 forward-migration 'repair-child-sender-labels'. Before the fix a
// CHILD worktree's sends carried `from: primary-<sha(worktree)>` and its
// register-primary minted a phantom `primary-<childhash>` registry row that
// collected replies nobody read. For every registry row that is a CHILD
// worktree's own label (id === that worktree's meshId, worktree is not the
// Primary checkout — DevSwarm app builderType when known, else not the main
// worktree) with exactly ONE non-`primary-` registry row on the same worktree
// (the child's real id; the app's builder id preferred):
//   1. sender-aliases.json maps label -> child id (display: recent[] / gate),
//      history bodies and stored `from` values are never rewritten;
//   2. foldGroupIntoSurvivor(childLabel) forwards the label partition's unread
//      direct mail into the child's partition, THEN tombstones the label row and
//      writes the retired-redirect (routing). A LIVE label row is left
//      (retryable) — never retired under a running session.
// Idempotent, fail-open (errors counted), no message/file delete. dryRun (or
// ANTIHALL_INGEST_DRY_RUN=1) classifies only. Unprovable rows (deleted worktree
// with no app record, zero or 2+ child rows) are reported, never guessed.
function repairChildSenderLabelsAllStores(home, ctx) {
  const c = ctx || {};
  const env = c.env || process.env;
  const dryRun = !!c.dryRun || String((env && env.ANTIHALL_INGEST_DRY_RUN) || '') === '1';
  const out = { ok: true, dryRun, stores: 0, labels: 0, pending: 0, aliased: 0, retired: 0, forwarded: 0, left: [], errors: 0, results: [] };
  const aliasLib = require('../../companion/lib/devswarm-sender-alias.js');
  let appDb = null;
  try { appDb = require('../../companion/lib/devswarm-app-db.js'); } catch (_) { appDb = null; }
  const aliases = aliasLib.readAliases(home);
  let hashes = [];
  try { hashes = store.listStoreHashes(home) || []; } catch (_) { hashes = []; }
  for (const repoKey of hashes) {
    let s = null;
    try {
      s = store.openStore({ home, hash: repoKey, backend: c.backend, env, readOnly: dryRun });
      if (!s) continue;
      out.stores++;
      const registry = s.listRegistry() || [];
      for (const r of registry) {
        if (!r || r.id == null || !/^primary-/.test(String(r.id)) || !r.worktreePath) continue;
        const id = String(r.id);
        const canon = canonicalWorktreeRealPath(String(r.worktreePath));
        const label = canon ? canonicalMeshId(String(r.worktreePath)) : rawPathMeshId(String(r.worktreePath));
        if (label !== id) continue; // not this worktree's own label
        let app = null;
        try { app = appDb ? appDb.builderForWorktree({ home, env, worktreePath: canon || String(r.worktreePath) }) : null; } catch (_) { app = null; }
        let isChild = null;
        if (app && app.builderType) isChild = app.builderType !== 'primary';
        else if (canon) {
          const ic = identityContext(canon);
          isChild = !isPrimaryCheckout(ic.worktreeRoot, ic.mainWorktree, home, env);
        }
        if (isChild !== true) continue; // Primary checkout, or unprovable -> untouched
        out.labels++;
        const same = (d) => d && d.worktreePath && (canon
          ? canonicalWorktreeRealPath(String(d.worktreePath)) === canon
          : path.resolve(String(d.worktreePath)) === path.resolve(String(r.worktreePath)));
        const kids = Array.from(new Set(registry.filter((d) => d && d.id != null && !/^primary-/.test(String(d.id)) && same(d)).map((d) => String(d.id))));
        const childId = app && kids.includes(String(app.id)) ? String(app.id) : (kids.length === 1 ? kids[0] : null);
        if (!childId) { out.results.push({ repoKey, id, action: 'skipped', reason: kids.length ? 'ambiguous-child-row' : 'no-child-row' }); continue; }
        const needAlias = !(aliases[id] && aliases[id].to === childId);
        const cls = foldGroupIntoSurvivor(s, home, childId, [r], { dryRun: true, childLabel: true, repoKey });
        const wouldRetire = cls.retired.includes(id);
        if (needAlias || wouldRetire) out.pending++;
        if (!wouldRetire) out.left.push({ id, childId, reason: 'child-label-live' });
        if (dryRun) { out.results.push({ repoKey, id, childId, action: 'would-repair', alias: needAlias, retire: wouldRetire }); continue; }
        if (needAlias && aliasLib.writeAlias(home, id, childId, canon || String(r.worktreePath))) { out.aliased++; aliases[id] = { to: childId }; }
        if (!wouldRetire) { out.results.push({ repoKey, id, childId, action: 'aliased-left-live' }); continue; }
        const res = foldGroupIntoSurvivor(s, home, childId, [r], { lockCandidates: true, childLabel: true, repoKey });
        out.forwarded += res.forwarded || 0;
        if (res.retired.includes(id)) {
          out.retired++;
          out.results.push({ repoKey, id, childId, action: 'retired', forwarded: res.forwarded || 0 });
          // The label's descriptor (old register-primary) stays on disk (no
          // delete); an archived/<label>.json marker (never-clobber) keeps
          // heal-orphan-partitions from re-adopting the retired row from it.
          const desc = readDescriptorFile(home, id);
          if (desc) {
            try {
              const dir = checkedArchivedDir(home, { create: true });
              if (dir.ok) {
                const body = JSON.stringify(Object.assign({}, desc, { archivedBy: 'child-sender-label-repair', archivedAt: Date.now(), retiredTo: childId }));
                fs.writeFileSync(path.join(archivedDir(home), id + '.json'), body, { flag: 'wx' });
              }
            } catch (e) { if (!e || e.code !== 'EEXIST') { out.errors++; out.results.push({ repoKey, id, error: 'archived marker: ' + String((e && e.message) || e) }); } }
            // 0.108.4: a descriptor left in workspaces/ is what re-adopted the
            // folded label (a later drain promoted it back to live). Move it
            // out (rename into the archived-retired/ graveyard, never delete)
            // once the archived marker is in place.
            if (fs.existsSync(path.join(archivedDir(home), id + '.json'))) {
              try {
                const gdir = retiredMarkersDir(home);
                fs.mkdirSync(gdir, { recursive: true });
                fs.renameSync(descriptorPath(home, id), path.join(gdir, id + '.' + Date.now() + '.json'));
              } catch (e) { if (!e || e.code !== 'ENOENT') { out.errors++; out.results.push({ repoKey, id, error: 'descriptor move: ' + String((e && e.message) || e) }); } }
            }
          }
        }
        else {
          out.left.push({ id, childId, reason: (res.skipped && res.skipped.length) ? 'lock-busy' : (res.forwardFailed.length ? 'forward-failed' : 'raced-re-register') });
          if (res.forwardFailed.length) out.errors++;
        }
      }
      // Sender labels with NO registry row (the child only ever registered its
      // real id, e.g. field sender primary-e33f349f vs row 377cba74): alias
      // them too, so stored broadcasts/questions render under the child.
      try {
        const regIds = new Set(registry.map((d) => d && String(d.id)));
        const labels = new Set();
        const parts = [store.BROADCAST_PARTITION_ID].concat(registry.map((d) => d && d.id != null ? String(d.id) : null).filter(Boolean));
        for (const part of parts) {
          let rows = [];
          try { rows = s.listMessages(part) || []; } catch (_) { rows = []; }
          for (const m of rows) {
            const snd = m && m.sender != null ? String(m.sender) : '';
            if (/^primary-[0-9a-f]{8}$/.test(snd) && !regIds.has(snd) && !(aliases[snd])) labels.add(snd);
          }
        }
        if (labels.size) {
          const byLabel = new Map();
          for (const d of registry) {
            if (!d || d.id == null || !d.worktreePath || /^primary-/.test(String(d.id))) continue;
            const key = canonicalMeshId(String(d.worktreePath)) || rawPathMeshId(String(d.worktreePath));
            if (!key || !labels.has(key)) continue;
            if (!byLabel.has(key)) byLabel.set(key, []);
            byLabel.get(key).push(d);
          }
          for (const [label, rows] of byLabel) {
            const wt = canonicalWorktreeRealPath(String(rows[0].worktreePath));
            if (!wt) continue; // unprovable (deleted worktree): never guessed
            const ic = identityContext(wt);
            if (isPrimaryCheckout(ic.worktreeRoot, ic.mainWorktree, home, env)) continue;
            const ids = Array.from(new Set(rows.map((d) => String(d.id))));
            if (ids.length !== 1) { out.results.push({ repoKey, id: label, action: 'skipped', reason: 'ambiguous-child-row' }); continue; }
            out.labels++;
            out.pending++;
            if (dryRun) { out.results.push({ repoKey, id: label, childId: ids[0], action: 'would-alias-sender' }); continue; }
            if (aliasLib.writeAlias(home, label, ids[0], wt)) { out.aliased++; aliases[label] = { to: ids[0] }; out.results.push({ repoKey, id: label, childId: ids[0], action: 'aliased-sender' }); }
          }
        }
      } catch (e) { out.errors++; out.results.push({ repoKey, error: 'sender scan: ' + String((e && e.message) || e) }); }
      if (!dryRun && (out.retired || out.aliased)) { try { store.deriveSummary(s, { home, env }); } catch (_) { /* projection refresh is best-effort */ } }
    } catch (e) {
      out.errors++;
      out.results.push({ repoKey, error: String((e && e.message) || e) });
    } finally { if (s) { try { s.close(); } catch (_) {} } }
  }
  if (!dryRun) out.pending = 0; // applied: remaining work is reported via left[]
  return out;
}

// mergeSplitBackendStoresAllStores(home, ctx) — thin all-stores wrapper (same
// migrations.js shape as foldMeshDuplicatesAllStores/healOrphanPartitionsAllStores)
// over devswarm-store.js's mergeSplitBackendStoresAllStores — the backend-
// consistency-marker follow-up repair (defect #10 field report): a store that
// was ALREADY split (both devswarm.db and a non-empty journal/ holding real
// data) before the marker fix shipped keeps the non-chosen side's rows
// invisible until this runs. NO-DELETE (neither physical form is ever
// removed), idempotent (message dedupe by hash/content, registry union,
// cursors/reader-cursors max-only). ctx.dryRun -> report only, zero writes.
function mergeSplitBackendStoresAllStores(home, ctx) {
  return store.mergeSplitBackendStoresAllStores(home, ctx || {});
}

// reRetireResurrectedRows(home, ctx) — item 6, defect df54edf54804 field
// aftermath: a downstream project's `roster --json` on 0.99.0 showed ~43 legacy-slug
// registry rows the migration had resurrected (the four lost ids' twins plus
// the control's twin) — the migration gate built above (companion/lib/
// devswarm-archive-gate.js) PREVENTS this going forward, but a store already
// holding rows from a BEFORE-the-fix migration run needs a forward-hygiene
// pass to clean up the damage already done.
//
// NOT a duplicate of foldArchivedRegistryRows (below) — that migration
// predates and is unrelated to df54edf54804; it exists for the OLD
// single-id-tombstone cmdArchive bug (pre-9975d07) and its own header
// documents a DELIBERATELY conservative safety gate: foldGroupIntoSurvivor
// protects ANY candidate whose descriptor carries a self-consistent
// sessionId, "descriptor-backed row whose session is DEAD... is NOT draining
// anything" — i.e. it does NOT check actual current liveness at all, by
// design, to never risk tombstoning a possibly-distinct live sibling. That is
// exactly why it would NOT retire a resurrected row like T: T's own
// workspaces/T.json descriptor commonly still exists (it is what the
// migration read to resurrect the row in the first place), so
// foldGroupIntoSurvivor's gate protects it unconditionally regardless of
// whether T's session is actually alive.
//
// This pass is deliberately STRICTER and NARROWER: a row is a CANDIDATE only
// when it has a PROVEN archive link — its own archived/<id>.json marker, or a
// worktree-group match against a DIFFERENT id's marker (companion/lib/
// devswarm-archive-gate.js's buildArchivedWorktreeIndex). A descriptor-less
// row with NO archive link at all is NEVER a candidate here — that is
// healOrphanPartitions' job (it already classifies an unread-without-a-
// forward-target orphan as `unhealable` rather than guessing). R2 fix (P0,
// live-run repro): the original version treated bare descriptor-ABSENCE as
// sufficient on its own, so a plain register-only phantom (`unclaimed:`
// sessionId, real unread mail, no archive link whatsoever) was removed with
// its mail simply stranded — 0 forwarded, nowhere for it to go. Requiring an
// archivedHit closes that: nothing is ever removed without first knowing
// exactly which archived partition, if any, its mail belongs in.
//
// A candidate is NOT live by isSiblingPartitionLive (the SAME positive-
// evidence predicate the migration gate uses — never a bare descriptor-
// presence check).
//
// Two ways a candidate is classified `unhealable` (LEFT in place, reported,
// never removed) instead of re-retired:
//   - the resolved archivedHit IS the row's own id (the only marker at this
//     worktree is this id itself) — there is no OTHER partition to forward
//     into, and this shape belongs to the migration gate's direct-marker
//     case, not this pass's worktree-group scope;
//   - forwardArchivedOrphanUnread THROWS, or the row has unforwarded
//     forwardable rows left over (neither delivered nor legitimately stale)
//     after the attempt — a genuine forward failure, never silently dropped.
//
// R2 fix (P1): each candidate's classify+forward+remove runs under
// withIdLock(id, home, ...) with the row RE-READ from a fresh listRegistry()
// inside the lock (same discipline as healOrphanPartitions :4938,
// retireArchivedWorktreeGroup's fold, foldGroupIntoSurvivor) — a row a
// concurrent register/ensure re-touched in the window between this pass's
// outer snapshot and its own turn is left untouched, never raced.
//
// Action per candidate: forward any unread DIRECTS into a same-worktree
// archived id (forwardArchivedOrphanUnread — the SAME primitive
// retireArchivedWorktreeGroup uses), then s.removeRegistry(id) — REGISTRY
// ONLY, never a file. Journaled via alog.logEvent('devswarm-cli',
// 're-retire-resurrected', ...) per row, matching every other consequential
// event this file logs (see logVerbOutcome's `event, details` shape).
// IDEMPOTENT (a re-retired row is gone from listRegistry, so a second pass
// finds no candidate), FAIL-OPEN (never throws; a per-row error is counted,
// never aborts the sweep), NO-DELETE-OF-FILES.
// ctx.dryRun classifies only (doctor detect()/report mode) — no lock, no
// write, no forward.
function reRetireResurrectedRows(home, ctx) {
  const c = ctx || {};
  const dryRun = !!c.dryRun;
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  const out = {
    ok: true, scope: 'store', candidates: 0, reRetired: 0, forwarded: 0, skippedLive: 0, unhealable: 0, pending: 0, errors: 0, detail: [],
  };
  const repoKey = typeof c.repoKey === 'string' && c.repoKey ? c.repoKey : repoKeyForCwd(c);
  out.repoKey = repoKey || null;
  if (!repoKey) return out;
  let storeExists = false;
  try { storeExists = fs.existsSync(store.storeDirForHash(home, repoKey)); } catch (_) { storeExists = false; }
  if (!storeExists) return out;
  const s = store.openStore({ home, hash: repoKey, backend: c.backend, env: c.env });
  try {
    const archivedWorktreeIndex = archiveGateLib.buildArchivedWorktreeIndex(home, fs);
    let registry = [];
    try { registry = s.listRegistry() || []; }
    catch (e) { out.ok = false; out.errors++; return out; }

    for (const row of registry) {
      if (!row || row.id == null) continue;
      const id = String(row.id);
      if (!isSafeId(id)) continue;

      let desc = null;
      try { desc = readDescriptorFile(home, id); } catch (_) { desc = null; }
      const rowWt = (desc && desc.worktreePath) || row.worktreePath || null;
      let archivedHit = null;
      if (rowWt) {
        const real = archiveGateLib.realWorktreePath(rowWt, fs);
        const hits = real ? archivedWorktreeIndex.get(real) : null;
        if (hits && hits.length) archivedHit = hits.find((h) => String(h.id) !== id) || hits[0];
      }
      // Criterion 1 (R2 P0 fix): a PROVEN archive link is REQUIRED to be a
      // candidate at all — never bare descriptor-absence on its own.
      if (!archivedHit) continue;

      // Criterion 2: NOT live — positive-evidence check, never bare presence.
      let live = false;
      try {
        live = isSiblingPartitionLive({ id, sessionId: row.sessionId, worktreePath: rowWt }, home, { now });
      } catch (_) { live = false; }
      if (live) { out.skippedLive++; out.detail.push({ id, action: 'skipped-live' }); continue; }

      // "No forward target": the only marker at this worktree IS this id's
      // own — not a group-sibling shape at all. Never guess; leave it,
      // report it.
      if (String(archivedHit.id) === id) {
        out.unhealable++;
        out.detail.push({ id, action: 'unhealable', reason: 'no-forward-target' });
        continue;
      }

      out.candidates++;
      if (dryRun) {
        out.detail.push({ id, action: 'would-re-retire', forwardTo: archivedHit.id });
        continue;
      }

      const targetId = archivedHit.id;
      const lockRes = withIdLock(id, home, () => {
        // RE-READ under the lock (R2 P1 fix): a concurrent register/ensure
        // that re-touched this row in the window since the outer snapshot
        // must never be raced. Any change to sessionId means someone else
        // owns this row now — leave it, do nothing.
        let freshRegistry = [];
        try { freshRegistry = s.listRegistry() || []; } catch (_) { freshRegistry = []; }
        const fresh = freshRegistry.find((r0) => r0 && String(r0.id) === id);
        if (!fresh) return { outcome: 'vanished' }; // already gone — nothing to do
        if (String(fresh.sessionId != null ? fresh.sessionId : '') !== String(row.sessionId != null ? row.sessionId : '')) {
          return { outcome: 'raced' }; // re-touched since the snapshot — leave it
        }
        let unreadTotal = 0;
        try {
          const since = floorCursor(s, id, home);
          unreadTotal = (s.listMessages(id, { sinceCursor: since }) || []).filter(isForwardable).length;
        } catch (_) { unreadTotal = 0; }
        let fwd = null;
        // allowArchivedDest: re-retire moves a resurrected twin's (archived-origin)
        // rows back into its archived family partition, by design.
        try { fwd = forwardArchivedOrphanUnread(s, id, targetId, { now, home, allowArchivedDest: true }); }
        catch (_) { fwd = null; }
        if (!fwd) return { outcome: 'forward-failed' };
        if (fwd.status !== 'ok') return { outcome: 'pending', reason: 'survivor-' + fwd.status };
        const accounted = (fwd.forwarded || 0) + (fwd.stale || 0);
        if (unreadTotal > 0 && accounted < unreadTotal) {
          // Some forwardable unread mail was neither delivered nor
          // legitimately classified stale — a genuine partial failure.
          // Never remove a row with unaccounted-for mail.
          return { outcome: 'forward-incomplete', forwarded: fwd.forwarded || 0 };
        }
        let removed = false;
        try { s.removeRegistry(id); removed = true; } catch (_) { removed = false; }
        if (!removed) return { outcome: 'remove-failed', forwarded: fwd.forwarded || 0 };
        return { outcome: 'removed', forwarded: fwd.forwarded || 0 };
      });

      if (lockRes && lockRes.lockBusy) {
        out.pending++;
        out.detail.push({ id, action: 'skipped', reason: 'lock-busy' });
        continue;
      }
      const outcome = lockRes && lockRes.outcome;
      if (outcome === 'pending') {
        out.pending++;
        out.detail.push({ id, action: 'pending', reason: lockRes.reason, forwardTo: targetId });
        continue;
      }
      if (outcome === 'vanished' || outcome === 'raced') {
        out.detail.push({ id, action: 'skipped', reason: outcome });
        continue;
      }
      if (outcome === 'forward-failed' || outcome === 'forward-incomplete') {
        out.unhealable++;
        out.detail.push({ id, action: 'unhealable', reason: outcome, forwardTo: targetId, forwarded: (lockRes && lockRes.forwarded) || 0 });
        continue;
      }
      if (outcome === 'remove-failed') {
        out.errors++;
        out.detail.push({ id, action: 'error', reason: 'removeRegistry failed' });
        continue;
      }
      // outcome === 'removed'
      out.reRetired++;
      out.forwarded += (lockRes && lockRes.forwarded) || 0;
      try {
        alog.logEvent('devswarm-cli', 're-retire-resurrected', 'info', {
          row: id, forwardTo: targetId, forwarded: (lockRes && lockRes.forwarded) || 0,
        });
      } catch (_) {}
      out.detail.push({ id, action: 're-retired', forwardedTo: targetId, forwarded: (lockRes && lockRes.forwarded) || 0 });
    }
    if (!dryRun && out.reRetired) {
      try { store.deriveSummary(s, { home, env: c.env, now: c.now }); } catch (_) {}
    }
  } finally { s.close(); }
  return out;
}

// reRetireResurrectedRowsAllStores(home, ctx) — same cross-store sweep shape
// as healOrphanPartitionsAllStores/foldMeshDuplicatesAllStores: sweeps EVERY
// store this machine has ever opened (store.listStoreHashes(home)), healing
// each directly by its stored hash. Per-store errors are counted and never
// abort the sweep.
function reRetireResurrectedRowsAllStores(home, ctx) {
  const c = ctx || {};
  let hashes = [];
  try { hashes = store.listStoreHashes(home) || []; } catch (_) { hashes = []; }
  let candidates = 0, reRetired = 0, forwarded = 0, skippedLive = 0, unhealable = 0, pending = 0, errors = 0;
  const results = [];
  for (const repoKey of hashes) {
    let r = null;
    try { r = reRetireResurrectedRows(home, Object.assign({}, c, { repoKey })); }
    catch (e) { r = { ok: false, error: String(e && e.message || e), candidates: 0, reRetired: 0, forwarded: 0, skippedLive: 0, unhealable: 0, errors: 0, detail: [] }; }
    if (!r) continue;
    if (r.ok === false) { errors++; results.push({ repoKey, ok: false, error: r.error }); continue; }
    candidates += r.candidates || 0;
    reRetired += r.reRetired || 0;
    forwarded += r.forwarded || 0;
    skippedLive += r.skippedLive || 0;
    unhealable += r.unhealable || 0;
    pending += r.pending || 0;
    errors += r.errors || 0;
    if (r.candidates || r.reRetired || r.unhealable || r.pending || r.errors) {
      results.push({
        repoKey, ok: true, candidates: r.candidates || 0, reRetired: r.reRetired || 0,
        forwarded: r.forwarded || 0, skippedLive: r.skippedLive || 0, unhealable: r.unhealable || 0,
        pending: r.pending || 0, errors: r.errors || 0, detail: r.detail,
      });
    }
  }
  return {
    ok: true, scope: 'all-stores', stores: hashes.length, candidates, reRetired, forwarded, skippedLive, unhealable, pending, errors, results,
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
// foldArchivedFamilyResumePath(home) -> ~/.anti-hall/devswarm/fold-archived-family-resume.json
// (D11-C). Same additive/fail-open/overwritten-each-pass style as
// foldArchivedResumePath, but a flat id list — this pass has no per-bucket
// axis (one descriptor directory walk, not a per-store sweep).
function foldArchivedFamilyResumePath(home) {
  return path.join(home, '.anti-hall', 'devswarm', 'fold-archived-family-resume.json');
}
function readFoldArchivedFamilyResume(home) {
  try {
    const raw = fs.readFileSync(foldArchivedFamilyResumePath(home), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.ids)) return parsed.ids.filter((x) => typeof x === 'string');
  } catch (_) { /* fail-open: no resume marker */ }
  return [];
}
function writeFoldArchivedFamilyResume(home, ids) {
  try {
    const p = foldArchivedFamilyResumePath(home);
    if (!ids || ids.length === 0) {
      try { fs.unlinkSync(p); } catch (_) { /* already absent — fine */ }
      return;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ids, ts: Date.now() }));
  } catch (_) { /* fail-open: resume marker is best-effort */ }
}

function foldArchivedFamilyDescriptors(home, ctx0) {
  const dryRun = !!(ctx0 && ctx0.dryRun);
  const ctx = ctx0 || {};
  const out = { ok: true, action: 'fold-archived-family-descriptors', dryRun, scanned: 0, pending: 0, retired: [], left: [], errors: 0 };
  try {
    const ad = checkedArchivedDir(home);
    if (!ad.ok || !ad.exists) return out;
    let names = [];
    try { names = fs.readdirSync(ad.path); } catch (_) { names = []; }
    // Pre-filter to genuine candidates FIRST (D11-C): the deadline below gates
    // real work items, not every directory entry — mirrors healOrphanPartitions'
    // own up-front resolve-then-gate shape.
    const candidates = [];
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
      candidates.push({ aid, desc });
    }
    // BUDGET + RESUME (D11-C): rotation mirrors cmdReconcile's own
    // readReconcileResume/writeReconcileResume (Wave D9) — whatever a pass
    // left un-swept is prioritized FIRST next time. Fail-open on a
    // corrupt/missing marker (empty resume == full fresh scan, unchanged).
    const resumeIds = readFoldArchivedFamilyResume(home).filter((id) => candidates.some((c) => c.aid === id));
    const resumeSet = new Set(resumeIds);
    const byId = new Map(candidates.map((c) => [c.aid, c]));
    const order = resumeIds.concat(candidates.map((c) => c.aid).filter((id) => !resumeSet.has(id)));
    let budgetExhausted = false;
    for (let oi = 0; oi < order.length; oi++) {
      const aid = order[oi];
      const c = byId.get(aid);
      if (!c) continue;
      // Stop BEFORE starting the next candidate once ctx.deadline has passed
      // — same "stop before an item, never mid-item" contract this file's
      // other throttled passes enforce. The FIRST candidate always runs
      // regardless of budget (forward-progress guarantee).
      if (oi > 0 && Number.isFinite(ctx.deadline) && Date.now() >= ctx.deadline) {
        budgetExhausted = true;
        writeFoldArchivedFamilyResume(home, order.slice(oi));
        out.budgetExhausted = true;
        out.skipped = order.length - oi;
        break;
      }
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
      try { r = retireIdentityFamilyDescriptors(home, aid, c.desc, { dryRun, requireWorktreeGone: true }); }
      catch (_) { out.errors++; continue; }
      for (const x of r.retired) out.retired.push(String(x));
      for (const x of r.left) out.left.push(x);
    }
    if (!budgetExhausted) writeFoldArchivedFamilyResume(home, []);
    out.pending = out.retired.length;
    return out;
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.message) || e);
    return out;
  }
}

// foldArchivedResumePath(home) -> ~/.anti-hall/devswarm/fold-archived-resume.json
// (D11-C, defect e7307778b614). Same style as reconcileResumePath: additive,
// fail-open, overwritten each pass.
function foldArchivedResumePath(home) {
  return path.join(home, '.anti-hall', 'devswarm', 'fold-archived-resume.json');
}

// readFoldArchivedResume(home) -> { [bucket]: string[] } — archived ids left
// un-swept per store bucket by a prior budget-exhausted pass, or {} on any
// absence/corruption (fail-open: a bad marker never blocks or crashes the
// fold, it just means every bucket does a full fresh scan this pass).
function readFoldArchivedResume(home) {
  try {
    const raw = fs.readFileSync(foldArchivedResumePath(home), 'utf8');
    const parsed = JSON.parse(raw);
    const out = {};
    if (parsed && typeof parsed === 'object' && parsed.buckets && typeof parsed.buckets === 'object') {
      for (const k of Object.keys(parsed.buckets)) {
        if (Array.isArray(parsed.buckets[k])) out[k] = parsed.buckets[k].filter((x) => typeof x === 'string');
      }
    }
    return out;
  } catch (_) { return {}; }
}

// writeFoldArchivedResume(home, bucketsMap) -> void. Overwrites the marker
// with whatever is STILL deferred per bucket this pass, or removes it once
// nothing is deferred anywhere (a fully-drained pass never leaves a stale
// marker behind). Fail-open: a write failure never affects the fold's result.
function writeFoldArchivedResume(home, bucketsMap) {
  try {
    const p = foldArchivedResumePath(home);
    const hasAny = bucketsMap && Object.keys(bucketsMap).some((k) => Array.isArray(bucketsMap[k]) && bucketsMap[k].length);
    if (!hasAny) {
      try { fs.unlinkSync(p); } catch (_) { /* already absent — fine */ }
      return;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ buckets: bucketsMap, ts: Date.now() }));
  } catch (_) { /* fail-open: resume marker is best-effort */ }
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
    const archivedById = new Map(archived.map((a) => [a.id, a]));
    const allArchivedIds = archived.map((a) => a.id);

    // 2) Sweep EVERY per-project store bucket (both bucket forms — see header).
    let hashes = [];
    try { hashes = store.listStoreHashes(home) || []; } catch (_) { hashes = []; }

    // BUDGET + RESUME (D11-C, defect e7307778b614): this sweep is O(archived
    // ids × store buckets) and previously had NO ctx.deadline of its own — a
    // machine with enough archived workspaces / stores never finished inside
    // update.js's post-pull run (field-measured: still running when the whole
    // run was killed at a 300s ceiling). Resume rotation mirrors cmdReconcile's
    // own readReconcileResume/writeReconcileResume pattern (Wave D9), scoped
    // per store bucket (this file's stand-in for repoKey — every bucket IS one
    // project's store): whatever a bucket left un-swept this pass is
    // prioritized FIRST for that SAME bucket next pass. Fail-open on a
    // corrupt/missing marker (empty resume == full fresh scan per bucket,
    // byte-identical to pre-fix behavior).
    const resumeByBucket = readFoldArchivedResume(home);
    const remainingByBucket = {};
    let budgetExhausted = false;
    let pairsChecked = 0; // global count across every bucket — backs the "first pair always runs" guarantee

    // idsForBucket(bucket) -> resumed ids first (rotation), then every other
    // archived id in scan order. A deferred id no longer in `archived` (the
    // workspace was un-archived, or its own row already retired by a prior
    // pass) is simply dropped — nothing left to fold for it.
    const idsForBucket = (bucket) => {
      const resumeIds = (resumeByBucket[bucket] || []).filter((id) => archivedById.has(id));
      const resumeSet = new Set(resumeIds);
      return resumeIds.concat(allArchivedIds.filter((id) => !resumeSet.has(id)));
    };

    for (let hi = 0; hi < hashes.length; hi++) {
      const bucket = hashes[hi];
      if (budgetExhausted) {
        // Budget already spent by an earlier bucket this pass — defer this
        // bucket's WHOLE id list without ever opening its store.
        remainingByBucket[bucket] = idsForBucket(bucket);
        continue;
      }
      let s = null;
      try { s = store.openStore({ home, hash: bucket, backend: ctx.backend, env: ctx.env }); }
      catch (_) { out.errors++; continue; } // unreadable store: SKIPPED, never wiped
      try {
        // Hoisted OUT of the per-id loop (perf fix, defect e7307778b614): the
        // pre-fix loop re-read s.listRegistry() once per (bucket, archived id)
        // PAIR — O(archived × stores) redundant full-registry reads against a
        // store that can hold thousands of rows. Read once per bucket here;
        // refreshed only after an actual registry WRITE to this bucket this
        // pass (`rowsDirty` below) — rare relative to the per-id check volume,
        // the only thing that can move this cache stale.
        let rows = [];
        try { rows = s.listRegistry() || []; } catch (_) { out.errors++; rows = []; }
        let rowsDirty = false;
        const ids = idsForBucket(bucket);
        for (let ii = 0; ii < ids.length; ii++) {
          const aid = ids[ii];
          const a = archivedById.get(aid);
          if (!a) continue;
          // Stop BEFORE starting the next pair once ctx.deadline has passed —
          // same "stop before an item, never mid-item" contract
          // update.js's own runThrottledSweep enforces. The very FIRST pair
          // across the WHOLE sweep always runs regardless of budget
          // (forward-progress guarantee); every pair after that is gated.
          if (pairsChecked > 0 && Number.isFinite(ctx.deadline) && Date.now() >= ctx.deadline) {
            budgetExhausted = true;
            remainingByBucket[bucket] = ids.slice(ii);
            break;
          }
          pairsChecked++;
          if (rowsDirty && !dryRun) {
            try { rows = s.listRegistry() || []; } catch (_) { out.errors++; }
            rowsDirty = false;
          }
          const ownRow = rows.find((d) => d && d.id != null && String(d.id) === aid) || null;
          const sameWorktree = a.real
            ? rows.filter((d) => d && d.id != null && String(d.id) !== aid && d.worktreePath
                && canonicalWorktreeRealPath(d.worktreePath) === a.real)
            : [];
          if (!ownRow && !sameWorktree.length) continue; // nothing of this archived id lives here
          // WHERE the siblings' unread goes — chosen by LIVENESS, identical rule to
          // the archive-time path (pickArchiveForwardSurvivor; see its header). The
          // archived id's own row is tombstoned a few lines below, so forwarding into
          // it while a LIVE sibling still holds this worktree would bury a real
          // unanswered direct in a partition nothing drains.
          const survivorId = pickArchiveForwardSurvivor(s, home, aid, sameWorktree);
          const foldCandidates = sameWorktree.filter((d) => d && String(d.id) !== survivorId);
          const survivorIsOther = survivorId !== String(aid);
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
            if (ownRow) { out.retired.push(aid + '@' + bucket); out.pending++; }
            continue;
          }
          const r = withIdLock(aid, home, () => {
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
            const g = foldGroupIntoSurvivor(s, home, survivorId, foldCandidates, { lockCandidates: true, allowArchivedDest: !survivorIsOther });
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
            out.left.push({ id: aid, bucket, reason: 'lock-busy' });
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
          if (r.ownRetired) out.retired.push(aid + '@' + bucket);
          else if (ownRow) out.left.push({ id: aid, bucket, reason: 'raced-re-register' });
          if (g.retired.length || g.forwarded || r.ownRetired) rowsDirty = true;
          // Refresh the projection whenever anything actually changed — a forward
          // with no tombstone still delivers real messages that must be visible to
          // every summary.json reader (the same gap retireWorktreeDuplicates closes).
          if (g.retired.length || g.forwarded || r.ownRetired) {
            try { store.deriveSummary(s, { home, env: ctx.env }); } catch (_) { out.errors++; }
          }
        }
      } finally { try { s.close(); } catch (_) {} }
    }
    writeFoldArchivedResume(home, remainingByBucket);
    if (budgetExhausted) {
      out.budgetExhausted = true;
      out.skipped = Object.keys(remainingByBucket).reduce((n, k) => n + remainingByBucket[k].length, 0);
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
    const tmp = p + '.' + process.pid + '.' + nextHeartbeatTmp() + '.tmp';
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

// ---------------------------------------------------------------------------
// identity-rekey-candidates (mesh redesign Phase 2 B1) — READ-ONLY report.
// B1 flipped the repoKey of the SUBMODULE kinds only (submodule in a linked
// worktree, non-absorbed or embedded submodule, nested submodule, linked worktree
// OF a submodule): rows an older build wrote under the OLD key sit in
// store/<oldKey>/, which nothing reads any more. This finds those stores and
// reports them. It NEVER writes, merges, or moves anything: store cursors are
// positions in one partition, so merging across stores is deferred to Phase 3
// (reader_cursors), where positions stop being per-store.
//
// DETECTION is forward from the git layout, never by inverting a hash. Projects
// come from every descriptor's worktreePath (active + archived) plus ctx.cwd. For
// each project:
//   - every submodule gitdir under <commonDir>/modules/** and
//     <commonDir>/worktrees/*/modules/** (absorbed submodules and the linked
//     worktrees that share that gitdir as their common dir);
//   - every nested `.git` DIRECTORY found by identity.findNestedCheckouts (depth
//     REKEY_WALK_DEPTH, node_modules/.git skipped) in each worktree of the project:
//     non-absorbed submodules and embedded gitlink repos.
// The OLD key is the frozen legacy formula over that gitdir:
//   sanitizeRepoName(basename(dirname(realpath(gitdir)))) + '-' + sha256(realpath(gitdir))[0:6]
// A candidate needs store/<oldKey>/ to exist, oldKey != the key identity now gives
// that checkout, and oldKey not being the live key of any known descriptor (an
// untracked nested repo keeps its own key and is never reported). A store whose
// git metadata was already pruned (deleted worktree AND its gitdir) cannot be
// found this way.
const REKEY_WALK_DEPTH = 5;

function rekeyLegacyKeyForGitdir(realGitdir) {
  return repokey.sanitizeRepoName(path.basename(path.dirname(realGitdir))) + '-'
    + crypto.createHash('sha256').update(realGitdir).digest('hex').slice(0, 6);
}

// rekeyStoreCounts(home, key) -> { messages, partitions, registryRows,
// registryWorktrees: [path], liveWal } read WITHOUT writing: journal files are
// read directly; sqlite is opened `immutable=1` (no -wal/-shm created). A sqlite
// store with a non-empty -wal has rows the immutable read cannot see: `liveWal`
// is true and the counts are a lower bound. Throws on an unreadable store.
function rekeyStoreCounts(home, key) {
  const out = { messages: 0, partitions: 0, registryRows: 0, registryWorktrees: [], liveWal: false };
  const parts = new Set();
  const wts = new Set();
  const readLines = (f) => {
    let raw = '';
    try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
    const rows = [];
    for (const line of raw.split('\n')) { if (line.trim()) { try { rows.push(JSON.parse(line)); } catch (_) { /* torn line */ } } }
    return rows;
  };
  const jdir = store.journalDirForHash(home, key);
  if (fs.existsSync(jdir)) {
    if (!fs.statSync(jdir).isDirectory()) throw new Error('journal is not a directory');
    for (const r of readLines(path.join(jdir, 'messages.ndjson'))) { out.messages++; parts.add(String(r.workspaceId)); }
    const regIds = new Set();
    for (const r of readLines(path.join(jdir, 'registry.ndjson'))) {
      if (r && r.id != null) regIds.add(String(r.id));
      if (r && typeof r.worktreePath === 'string' && r.worktreePath) wts.add(r.worktreePath);
    }
    out.registryRows += regIds.size;
  }
  const db = store.sqlitePathForHash(home, key);
  if (fs.existsSync(db)) {
    try { out.liveWal = fs.statSync(db + '-wal').size > 0; } catch (_) { out.liveWal = false; }
    const { DatabaseSync } = require('../../companion/lib/sqlite-quiet.js').requireSqlite();
    const uri = 'file:' + db.split(path.sep).map(encodeURIComponent).join('/') + '?immutable=1';
    const conn = new DatabaseSync(uri, { readOnly: true });
    try {
      for (const r of conn.prepare('SELECT workspace_id AS w, COUNT(*) AS c FROM messages GROUP BY workspace_id;').all()) {
        out.messages += Number(r.c);
        parts.add(String(r.w));
      }
      for (const r of conn.prepare('SELECT worktree_path AS p FROM registry;').all()) {
        out.registryRows++;
        if (r.p) wts.add(String(r.p));
      }
    } finally { conn.close(); }
  }
  out.partitions = parts.size;
  out.registryWorktrees = Array.from(wts);
  return out;
}

// identityRekeyCandidates(home, ctx) -> { candidates: [{oldKey, newKey, source, gitdir}], projects }
function identityRekeyCandidates(home, ctx) {
  const wtPaths = new Set();
  for (const dir of [workspacesDir(home), archivedDir(home)]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { names = []; }
    for (const n of names) {
      if (!/\.json$/.test(n)) continue;
      const st = readDescriptorPathState(path.join(dir, n));
      const d = st && st.descriptor;
      if (d && typeof d.worktreePath === 'string' && d.worktreePath) wtPaths.add(d.worktreePath);
    }
  }
  if (ctx && ctx.cwd) wtPaths.add(String(ctx.cwd));
  const projects = new Map(); // commonDir -> { repoKey, mainWorktree }
  const liveKeys = new Set();
  for (const p of wtPaths) {
    const c = identity.resolveContext(p, { memo: false, superCache: true });
    if (!c.commonDir) continue;
    liveKeys.add(c.repoKey);
    if (!projects.has(c.commonDir)) projects.set(c.commonDir, { repoKey: c.repoKey, mainWorktree: c.mainWorktree });
  }
  const found = new Map(); // oldKey -> candidate
  const consider = (realGitdir, newKey, source) => {
    const oldKey = rekeyLegacyKeyForGitdir(realGitdir);
    if (!newKey || oldKey === newKey || liveKeys.has(oldKey) || found.has(oldKey)) return;
    try { if (!fs.statSync(store.storeDirForHash(home, oldKey)).isDirectory()) return; } catch (_) { return; }
    found.set(oldKey, { oldKey, newKey, source, gitdir: realGitdir });
  };
  const walkModules = (dir, newKey, source, depth) => {
    if (depth > 8) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const d = path.join(dir, e.name);
      let isGitdir = false;
      try { isGitdir = fs.statSync(path.join(d, 'HEAD')).isFile(); } catch (_) { isGitdir = false; }
      if (!isGitdir) { walkModules(d, newKey, source, depth + 1); continue; }
      let hasCommondir = false;
      try { hasCommondir = fs.statSync(path.join(d, 'commondir')).isFile(); } catch (_) { hasCommondir = false; }
      if (!hasCommondir) { try { consider(fs.realpathSync(d), newKey, source); } catch (_) { /* unreadable */ } }
      walkModules(path.join(d, 'modules'), newKey, source, depth + 1);
    }
  };
  for (const [commonDir, proj] of projects) {
    walkModules(path.join(commonDir, 'modules'), proj.repoKey, 'submodule-in-main', 0);
    const worktreeRoots = [proj.mainWorktree];
    let wts = [];
    try { wts = fs.readdirSync(path.join(commonDir, 'worktrees')); } catch (_) { wts = []; }
    for (const w of wts) {
      const wg = path.join(commonDir, 'worktrees', w);
      walkModules(path.join(wg, 'modules'), proj.repoKey, 'submodule-in-linked-worktree', 0);
      try {
        const g = String(fs.readFileSync(path.join(wg, 'gitdir'), 'utf8')).trim();
        if (g) worktreeRoots.push(path.dirname(path.resolve(wg, g)));
      } catch (_) { /* pruned worktree metadata */ }
    }
    // Nested `.git` DIRECTORIES: each one's new key comes from identity itself
    // (one cached spawn per nested repo), so an untracked repo — which keeps its
    // own key — is never a candidate.
    for (const root of worktreeRoots) {
      for (const d of identity.findNestedCheckouts(root, { maxDepth: REKEY_WALK_DEPTH })) {
        const c = identity.resolveContext(d, { memo: false, superCache: true });
        if (c.toplevel !== d) continue;
        try { consider(fs.realpathSync(path.join(d, '.git')), c.repoKey, c.submoduleDepth > 0 ? 'non-absorbed-submodule' : 'nested-repo'); } catch (_) { /* unreadable */ }
      }
    }
  }
  return { candidates: Array.from(found.values()), projects: projects.size };
}

// identityRekeyReport(home, ctx0) -> { ok, action, projects, stores: [{ dir, oldKey,
// newKey, source, messages, partitions, registryRows, registryWorktrees,
// worktreeExists, liveWal, error? }], totals: { stores, messages, registryRows } }.
// READ-ONLY: never writes, never throws. `worktreeExists`: true/false when the
// store's registry names worktrees (true if any still exists), null when it names none.
function identityRekeyReport(home, ctx0) {
  const ctx = Object.assign({}, ctx0 || {});
  const out = { ok: true, action: 'identity-rekey-candidates', projects: 0, stores: [],
    totals: { stores: 0, messages: 0, registryRows: 0 } };
  let found = { candidates: [], projects: 0 };
  try { found = identityRekeyCandidates(home, ctx); } catch (e) { out.ok = false; out.error = String(e && e.message || e); }
  out.projects = found.projects;
  for (const cand of found.candidates) {
    const row = { dir: store.storeDirForHash(home, cand.oldKey), oldKey: cand.oldKey, newKey: cand.newKey, source: cand.source };
    try {
      const c = rekeyStoreCounts(home, cand.oldKey);
      Object.assign(row, c);
      row.worktreeExists = c.registryWorktrees.length
        ? c.registryWorktrees.some((p) => { try { return fs.existsSync(p); } catch (_) { return false; } })
        : null;
      out.totals.messages += c.messages;
      out.totals.registryRows += c.registryRows;
    } catch (e) {
      row.error = String(e && e.message || e);
      out.ok = false;
    }
    out.stores.push(row);
  }
  out.totals.stores = out.stores.length;
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
    // deliberate: under-detect only (skip a report, never a removal decision) — bare marker check is fine here.
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

// foldReadReceiptsAllStores(home, ctx) -> { ok, dryRun, stores, ids, pending,
//   folded, errors, results[] }. Repair for read receipts written BEFORE
// canonicalReceiptId existed (writeReadReceipt used to file every receipt
// under the literal caller id): for every registry row of every store, if
// that id's read-receipt directory holds files AND canonicalReceiptId(s, id,
// worktreePath) resolves to a DIFFERENT id, COPY (never move/delete) each
// receipt file not already present under the canonical id's directory.
// readReadReceipt already tries both the canonical and the literal dir at
// lookup time, so this repair is a convenience (a single canonical copy any
// future alias can find without also re-deriving `dirId` at read time — e.g.
// `inbox count`/`diagnose` surfaces that only ever look at the literal id
// dir) rather than a correctness requirement. Idempotent (re-run copies
// nothing once every file already exists at the canonical dir) and NO-DELETE
// — the literal-id directory and its files are left in place forever, exactly
// like every other migration in this file. dryRun (or
// ANTIHALL_INGEST_DRY_RUN=1) counts only. Fail-open: a per-id or per-store
// error is counted, never thrown.
function foldReadReceiptsAllStores(home, ctx) {
  const c = ctx || {};
  const env = c.env || process.env;
  const dryRun = !!c.dryRun || String((env && env.ANTIHALL_INGEST_DRY_RUN) || '') === '1';
  const out = { ok: true, dryRun, stores: 0, ids: 0, pending: 0, folded: 0, errors: 0, results: [] };
  let hashes = [];
  try { hashes = store.listStoreHashes(home) || []; } catch (_) { hashes = []; }
  for (const repoKey of hashes) {
    let s = null;
    try {
      s = store.openStore({ home, hash: repoKey, backend: c.backend, env, readOnly: dryRun });
      if (!s) continue;
      out.stores++;
      const registry = s.listRegistry() || [];
      for (const row of registry) {
        if (!row || !row.worktreePath || !isSafeId(String(row.id))) continue;
        const id = String(row.id);
        let literalDir;
        try { literalDir = readReceiptDir(home, id); } catch (_) { continue; }
        let literalFiles = [];
        try { literalFiles = fs.readdirSync(literalDir).filter((f) => /^r[a-z0-9]+\.json$/.test(f)); } catch (_) { continue; }
        if (!literalFiles.length) continue;
        out.ids++;
        let canonicalId;
        try { canonicalId = canonicalReceiptId(s, id, row.worktreePath); } catch (_) { canonicalId = id; }
        if (canonicalId === id) continue;
        const canonicalDir = readReceiptDir(home, canonicalId);
        let missing = [];
        try {
          const already = new Set(fs.existsSync(canonicalDir) ? fs.readdirSync(canonicalDir) : []);
          missing = literalFiles.filter((f) => !already.has(f));
        } catch (_) { out.errors++; continue; }
        if (!missing.length) continue;
        out.pending += missing.length;
        if (dryRun) { out.results.push({ id, canonicalId, wouldFold: missing.length }); continue; }
        let folded = 0;
        for (const f of missing) {
          try {
            fs.mkdirSync(canonicalDir, { recursive: true });
            const src = path.join(literalDir, f);
            const dst = path.join(canonicalDir, f);
            const tmp = dst + '.tmp';
            fs.writeFileSync(tmp, fs.readFileSync(src));
            fs.renameSync(tmp, dst);
            folded++;
          } catch (_) { out.errors++; }
        }
        out.folded += folded;
        out.results.push({ id, canonicalId, folded, attempted: missing.length });
      }
    } catch (e) {
      out.errors++;
      out.results.push({ repoKey, error: String((e && e.message) || e) });
    } finally { if (s) { try { s.close(); } catch (_) {} } }
  }
  return out;
}

module.exports = {
  foldMeshDuplicatesAllStores, healOrphanPartitions, healOrphanPartitionsAllStores,
  importReaderCursorsAllStores, repairReaderFloorsAllStores, BUILDER_UUID_RE, appDeletedBuilder,
  refreshNamesFromApp, appStatePath, readJsonDescriptors, MESSAGE_SETTLE_MS, messageGaps,
  APP_GAP_COOLDOWN_MS, syncAppState, writeAtomicJson, cmdAppState, formatAppState, cmdSyncUi,
  markAppArchivedDescriptors, RETIRE_MARKER_GRACE_MS, APP_SOURCED_MARKERS,
  retireStaleArchivedMarkers, reconcileDualPartitionAcks, reconcileDualPartitionAcksAllStores,
  repairChildSenderLabelsAllStores, mergeSplitBackendStoresAllStores, reRetireResurrectedRows,
  reRetireResurrectedRowsAllStores, foldArchivedFamilyResumePath, readFoldArchivedFamilyResume,
  writeFoldArchivedFamilyResume, foldArchivedFamilyDescriptors, foldArchivedResumePath,
  readFoldArchivedResume, writeFoldArchivedResume, foldArchivedRegistryRows, migrateOwnerKeys,
  REKEY_WALK_DEPTH, rekeyLegacyKeyForGitdir, rekeyStoreCounts, identityRekeyCandidates,
  identityRekeyReport, applyRecoveryIntents, rehomeStrandedProjectDescriptors,
  foldReadReceiptsAllStores,
};
