'use strict';
// anti-hall :: devswarm CLI — INBOX-READ module (scripts/devswarm-lib/inbox-read.js).
// Part of the devswarm.js split: a PURE MOVE out of scripts/devswarm.js (the CLI
// dispatcher). No behaviour change. Dependencies are explicit requires of core.js and
// of the lower modules; this module never requires devswarm.js at load time (the
// dispatcher's run() and export object reach it through core.cliRun / core.dispatcherExports).

const {
  CALLER_CWD, CLI_PATH, descriptorRegisteredRepoKey, fs, hasFlag, identityContext, inboxCursor,
  one, path, primaryCursorPath, readDescriptorFile, readerCursors, readRetiredRedirect,
  repoKeyForCwd, resolveStableCliPath, store,
} = require('./core.js');
const {
  callerIdentityDetailed, callerReaderKey, maybePromoteUnclaimed, ownershipRefusalCause,
  ownsAsDeclaredSelf, shortInstanceNonce, SYNTHETIC_SESSION_PREFIX,
} = require('./identity.js');
const {
  applyReadAckOps, readSiblingSeenCursor, siblingAckGate, siblingBaseCursor, writeReadReceipt,
} = require('./cursors.js');
const {
  CONSUMED_HASH_SEED_CAP, consumedDedupSeed, foldSiblingGapRows, forwardedOrigHashOf,
  maybeRehomeToCwdProject,
} = require('./fold.js');
const {
  resolveMeshPartitionIds, resolveMeshTarget, resolveSendTarget,
} = require('./send.js');

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
// readSideMeta(ctx, home, storeHandle, id) -> { repoKey, storePath, cwd }.
// Incident fix (defects 902d3c5e7531/1932b53a3ace, B1): every read-side JSON
// (`inbox count`, `read-primary`, `peek-primary`, `messages`) must carry
// enough context for an operator to tell WHICH physical store a read actually
// hit — the field incident that motivated this was a child's `read-primary`
// reporting count 0 while a message sat unreachable in a DIFFERENT repoKey
// bucket than the one the caller assumed. Best-effort/fail-open throughout —
// this is diagnostic metadata, never allowed to fail or alter a read.
// `refusal` (fl-wave3 fix, P2 item 4): when the caller is reporting an OPEN
// that was REFUSED (e.g. resolveWorkspaceStoreForRead's project-context-
// mismatch/unregistered-workspace shapes), pass that refusal object here.
// Pre-fix, `storePath` was always computed as if the open had succeeded —
// falling back to `store.hashFromWorkspaceId(id)`/the CALLER's own repoKey —
// so a refused read's diagnostic metadata pointed at a store this call never
// actually opened (misleading: "here is the store path" for a store that was
// never read). A refusal never opened ANY real store on this call's behalf,
// so `storePath` is now `null` for one; `registeredRepoKey` (the actual
// project the workspace IS registered under, when the refusal names one) is
// surfaced instead so the diagnostic still tells the operator where the real
// data lives.
function readSideMeta(ctx, home, storeHandle, id, refusal) {
  let repoKey = null;
  try { repoKey = repoKeyForCwd(ctx) || null; } catch (_) { repoKey = null; }
  const refused = !!(refusal && refusal.reason);
  let storePath = null;
  if (!refused) {
    try {
      const hash = (storeHandle && storeHandle.hash != null) ? storeHandle.hash
        : (repoKey != null ? repoKey : store.hashFromWorkspaceId(id));
      storePath = store.storeDirForHash(home, hash);
    } catch (_) { storePath = null; }
  }
  let cwd = null;
  try { cwd = (ctx && ctx.cwd) || process.cwd(); } catch (_) { cwd = null; }
  const out = { repoKey, storePath, cwd };
  if (refused && refusal.registeredRepoKey) out.registeredRepoKey = refusal.registeredRepoKey;
  return out;
}

// readSideKnown(rawKnown, withheld) -> the SHARED "known" formula every
// read-side verb must use (B1): `known` is false whenever the caller cannot
// trust the totals reported — the store side was unopenable
// (storeUnavailable), mesh-group enumeration failed (meshGroupUnresolved /
// meshGroupError), or the read is already flagged partial (totalsPartial).
// Pre-fix, `count`/`read`'s own `known` formula was `union.known &&
// !storeUnavailable` alone — it never folded in meshGroupUnresolved, so a
// mesh-enumeration failure (the exact field mechanism traced for
// 902d3c5e7531) still reported `known:true` alongside an undercounted total.
function readSideKnown(rawKnown, withheld) {
  const w = withheld || {};
  return !!rawKnown && !w.storeUnavailable && !w.meshGroupUnresolved && !w.meshGroupError && !w.totalsPartial;
}

// storeUnavailableOut(su, opts) -> { storeUnavailable, storeUnavailableReason, [storeUnavailableDetail] }
// fl-wave5 fix (item 1, read-side shape unification): every read verb
// (count/read/ack/read-primary/peek-primary/messages) must report
// `storeUnavailable` as a BOOLEAN with a top-level `storeUnavailableReason`
// (string|null) — count/read/ack used to embed the FULL detail object
// (reason/error/registeredRepoKey/callerRepoKey/storeUnavailableReason)
// directly AS `storeUnavailable` (via a `...(storeUnavailable ? {
// storeUnavailable, unreadStoreUnknown:true } : {})` spread that overrode
// the boolean set earlier in the same object literal), so a caller checking
// `typeof result.storeUnavailable === 'boolean'` — true for every OTHER
// read-side field on this shape — got an object instead on exactly the
// failure path where it mattered most. `su` is either falsy, the literal
// `true` (the early-refusal call sites, which have no richer detail to
// carry), or the richer detail object count/read/ack/messages build
// locally. `opts.detail:true` (count/read/ack only, per the shared
// contract) keeps that full object available under the separate
// `storeUnavailableDetail` key so no information is lost.
// fl-wave5 addendum fix (item 7, R4 Reviewer): a `su` OBJECT can carry a
// refusal reason that is NOT a genuine store error — `project-context-
// mismatch` (the store was never even attempted; the caller's project just
// doesn't match this id's registered one) and `unregistered-workspace` are
// real, more-specific refusals, distinct from `store-unavailable`/
// `store-open-failed` (the store genuinely could not be opened/read at
// all). Folding EVERY truthy `su` object into `storeUnavailable:true`
// (pre-fix) mislabeled a project-context-mismatch as a store outage. Only
// the two genuinely-unreadable-store reasons set `storeUnavailable:true`;
// every other object still reports `storeUnavailable:false` (matching the
// early-refusal call sites' own `failReason === 'store-unavailable'` rule)
// while its full detail — reason included — still lands under
// `storeUnavailableDetail` so no information is lost. `known:false` is
// unaffected: readSideKnown gates on the raw (truthy/falsy) `su` value
// passed to it separately, not on this boolean.
function isGenuineStoreUnavailableReason(reason) {
  return reason === 'store-unavailable' || reason === 'store-open-failed';
}
function storeUnavailableOut(su, opts) {
  if (!su) return { storeUnavailable: false, storeUnavailableReason: null };
  if (su === true) return { storeUnavailable: true, storeUnavailableReason: null };
  const genuine = isGenuineStoreUnavailableReason(su.reason);
  const out = { storeUnavailable: genuine, storeUnavailableReason: genuine ? (su.storeUnavailableReason || null) : null };
  if (opts && opts.detail) out.storeUnavailableDetail = su;
  return out;
}

// resolveReadArgToId(ctx, home, arg) -> { id, resolvedFrom, ambiguous, candidates }.
// B2 (defects 902d3c5e7531/1932b53a3ace, id-resolution parity): `send --to`
// accepts a meshId (resolveMeshTarget) OR an exact registry-row id
// (resolveSendTarget's shadow-guarded exact-id fallback) OR a one-hop
// fold-retired redirect — but `inbox count`/`read-primary`/`peek-primary`/
// `messages` opened the store keyed on `arg` LITERALLY, with none of that
// resolution: a meshId `send --to` could deliver to was refused by every
// read verb as unregistered. Mirrors resolveSendTarget's own priority (exact
// id first — never shadowed by a distinct row's derived meshId — then mesh,
// then one-hop redirect) by delegating to it directly (pure/read-only: it
// only inspects storeHandle.listRegistry(), no side effects), so the two
// surfaces can never independently drift on which id a given `arg` means.
// Fail-open: any resolution error (bad repoKey, store-open failure) leaves
// `id` at the literal `arg`, identical to the pre-fix behavior.
//
// fl-wave3 fix (item 6): this used to short-circuit to a plain `noOp` the
// MOMENT any row's id exactly equalled `arg` (`hasExact`), NEVER reaching
// resolveSendTarget at all in that case — but resolveSendTarget's OWN shadow
// guard (the `idMatches.length === 1` branch, ~line 10256) exists precisely
// to catch a genuine identity COLLISION even when an exact-id match exists:
// `arg` also happens to be a DIFFERENT live row's derived meshId, in a
// DIFFERENT worktree group. `send --to` correctly refuses that as
// `ambiguous-target`; a read verb going through this pre-fix shortcut
// silently used the exact-id row instead, with no warning — read and send
// drifted on what the SAME `arg` addresses. Always delegate to
// resolveSendTarget now (never short-circuit locally) so a genuine collision
// is surfaced identically on both surfaces. Every non-colliding case
// (exact-id-only, meshId-only, one-hop redirect, nothing at all) is
// UNCHANGED — resolveSendTarget's own exact-id branch already returns that
// exact row with `ambiguous:false` whenever there is no collision, which
// this function still folds back into the same `noOp` shape as before.
// fl-wave4 fix (item 0, Reviewer R3, defect 1932b53a3ace): an `arg` that
// EXACTLY equals a registered row's id must NEVER resolve to a DIFFERENT
// row on a READ, and must never be refused as ambiguous either — the
// pre-fix version delegated to resolveSendTarget unconditionally, and
// resolveSendTarget's OWN shadow guard (~line 10312, `idMatches.length===1`
// branch) can legitimately refuse an exact-id arg as ambiguous when it also
// collides with a DIFFERENT row's derived meshId — a deliberate `send`
// behavior (a write must never silently guess which of two colliding
// partitions the caller meant). A read has no such choice to make: `arg`
// IS the caller's own partition key the moment a row's id matches it
// exactly, full stop. Checking for that exact match FIRST (before ever
// calling resolveSendTarget) means this can never inherit send's collision
// refusal. Mesh-id / one-hop-redirect resolution (delegated to
// resolveSendTarget, ambiguity refusal included) still applies to every
// non-exact arg exactly as before.
function resolveReadArgToId(ctx, home, arg) {
  const id = String(arg);
  const noOp = { id, resolvedFrom: null, ambiguous: false, candidates: null };
  let repoKey = null;
  try { repoKey = repoKeyForCwd(ctx); } catch (_) { repoKey = null; }
  let s = null;
  try {
    s = store.openStore({ home, workspaceId: id, hash: repoKey || undefined, backend: ctx.backend, env: ctx.env });
    let hasExact = false;
    try {
      for (const d of s.listRegistry()) {
        if (d && d.id != null && String(d.id) === id) { hasExact = true; break; }
      }
    } catch (_) { hasExact = false; }
    if (hasExact) return noOp;
    const resolved = resolveSendTarget(s, id, home);
    if (resolved.ambiguous) return { id, resolvedFrom: null, ambiguous: true, candidates: resolved.candidates };
    if (resolved.target && String(resolved.target.id) !== id) {
      return { id: String(resolved.target.id), resolvedFrom: id, ambiguous: false, candidates: null };
    }
    return noOp;
  } catch (_) {
    return noOp;
  } finally {
    if (s) { try { s.close(); } catch (_) {} }
  }
}

// cwdInsideRegisteredWorktree(cwd, worktreePath) -> true iff realpath(cwd) equals or
// lies under realpath(worktreePath) or that path's git toplevel. Fail-closed:
// anything unresolvable (missing path, no registered path) is false.
function cwdInsideRegisteredWorktree(cwd, worktreePath) {
  if (!cwd || !worktreePath) return false;
  const cwdReal = identityContext(String(cwd), CALLER_CWD).cwdReal; // deleted cwd -> nearest existing ancestor
  if (!cwdReal) return false;
  const roots = [];
  try { roots.push(fs.realpathSync(String(worktreePath))); } catch (_) { return false; }
  const top = identityContext(String(worktreePath)).toplevel;
  if (top) roots.push(top);
  return roots.some((r) => cwdReal === r || cwdReal.startsWith(r + path.sep));
}

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
  let callerRepoKeyForRead = repoKeyForCwd(ctx);
  const descForRead = readDescriptorFile(home, id);
  const registeredRepoKeyForRead = descForRead ? descriptorRegisteredRepoKey(descForRead, id) : null;
  // #20: an UNRESOLVED caller key (null — e.g. the worktree's git metadata is
  // unreadable, or a resolver failure under load) is not evidence of a different
  // project. When the caller's cwd real path lies inside the workspace's OWN
  // registered worktree (its registered path or that path's git toplevel), read
  // under the registered key instead of refusing. A caller key that resolved to
  // a DIFFERENT project still refuses below.
  if (registeredRepoKeyForRead && !callerRepoKeyForRead
    && cwdInsideRegisteredWorktree((ctx && ctx.cwd) || process.cwd(), descForRead.worktreePath)) {
    callerRepoKeyForRead = registeredRepoKeyForRead;
  }
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
  // fl-wave4 fix (item 2, "silent zero on a broken store"): store.openStore
  // can now THROW a typed failure (devswarm-store.js's ESTOREUNAVAILABLE —
  // the sqlite backend's mkdirSync/DatabaseSync open failing on a chmod-000
  // dir or a corrupt db header). Map it to the SAME reason:'store-unavailable'
  // shape the journal backend's deferred getReadError() probe below produces,
  // carrying the underlying fs error code as storeUnavailableReason (e.g.
  // 'EACCES') so a caller/emitKnownWarning can name the REAL cause instead of
  // a generic, unactionable failure.
  let s;
  try {
    s = store.openStore({ home, workspaceId: id, hash: callerRepoKeyForRead || undefined, backend: ctx.backend, env: ctx.env });
  } catch (e) {
    return {
      ok: false, id,
      reason: 'store-unavailable',
      storeUnavailableReason: (e && e.storeUnavailableReason) || (e && e.code) || 'EUNKNOWN',
      error: 'store for workspace ' + JSON.stringify(id) + ' could not be opened: ' + ((e && e.message) || e),
    };
  }
  // getReadError() (journal backend only; sqlite always returns null — see
  // that handle's own header comment): the store DID open, but a deferred
  // read (below or already attempted by a caller reusing this handle) hit a
  // genuine fs error other than ENOENT. Probed HERE, unconditionally
  // (moved out of the `!descForRead` existence-guard branch below, which did
  // not always run) — right after the reads this function itself performs a
  // few lines down populate it. See the ready-error probe just before the
  // `return { ok: true, store: s }` at the end of this function.
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
  // fl-wave4 fix (item 2): `messageCount()` (never `listRegistry()`) is used
  // as the UNCONDITIONAL read-error probe here — it reads a DIFFERENT file
  // (messages.ndjson, not registry.ndjson) but hits the SAME broken store
  // dir for the same EACCES/ENOTDIR class of failure, so it is an equally
  // valid canary WITHOUT adding a new listRegistry() call to every open.
  // That distinction matters: cmdInboxMessages' own mesh-group-enumeration
  // logic further down this file (meshCandidateRows) makes its OWN
  // listRegistry() calls against this SAME handle and at least one existing
  // test (devswarm-mesh-union-review-fixes.test.js P1b) deliberately counts
  // them to inject a simulated failure at a SPECIFIC call — inserting an
  // extra listRegistry() call here would silently shift that numbering.
  // `hasRegistryRow` below is therefore still computed ONLY inside the
  // pre-existing `!descForRead && !skipExistenceGuard` guard, unchanged from
  // before this fix (same call, same position, same count).
  let hasMessages = false;
  try { hasMessages = s.messageCount(id) > 0; } catch (_) { hasMessages = false; }
  let readError = null;
  try { readError = (s.getReadError && s.getReadError()) || null; } catch (_) { readError = null; }
  if (readError) {
    try { s.close(); } catch (_) {}
    return {
      ok: false, id,
      reason: 'store-unavailable',
      storeUnavailableReason: readError.code || 'EUNKNOWN',
      error: 'store for workspace ' + JSON.stringify(id) + ' could not be read ('
        + (readError.code || 'EUNKNOWN') + ' on ' + JSON.stringify(readError.path) + ')',
    };
  }
  if (!descForRead && !skipExistenceGuard) {
    let hasRegistryRow = false;
    try { hasRegistryRow = (s.listRegistry() || []).some((r) => r && String(r.id) === String(id)); } catch (_) { hasRegistryRow = false; }
    if (!hasRegistryRow && !hasMessages) {
      // fl-wave8 fix (item 2, companion to the read-primary ownership fix
      // above): the getReadError() probe a few lines up ran BEFORE this
      // block's own listRegistry() call — at that point the handle had only
      // ever read messages.ndjson (via messageCount() for hasMessages), so
      // a registry.ndjson-SPECIFIC EACCES (the listRegistry() call just
      // above swallows it to []; see its own header comment) was not yet
      // recorded and this guard fell through to 'unregistered-workspace' for
      // a GENUINELY UNREADABLE registry, not a genuinely absent one — the
      // exact ghost-id-through-messages/read-primary/peek-primary case a
      // registry-only unreadable store hits. Re-probe getReadError() HERE,
      // now that listRegistry() has run and recorded any registry.ndjson
      // error against this same handle, before concluding the id is
      // unregistered.
      let existenceReadError = null;
      try { existenceReadError = (s.getReadError && s.getReadError()) || null; } catch (_) { existenceReadError = null; }
      if (existenceReadError) {
        try { s.close(); } catch (_) {}
        return {
          ok: false, id,
          reason: 'store-unavailable',
          storeUnavailableReason: existenceReadError.code || 'EUNKNOWN',
          error: 'store for workspace ' + JSON.stringify(id) + ' could not be read ('
            + (existenceReadError.code || 'EUNKNOWN') + ' on ' + JSON.stringify(existenceReadError.path) + ')',
        };
      }
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
// `read-primary` (which then acked and consumed; read-only since Phase 5) or (b) dumping the whole store. And
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
  // A deferred-ack read (Phase 5 read-primary) mutates nothing, so it is not a
  // drain; the drain marker is written by `ack-primary` instead.
  if (!inboxReadDoesAck(flags, opts) || (opts && opts.deferAck)) return cmdInboxMessagesInner(id, flags, ctx, opts);
  let marker = null;
  try {
    marker = require('../../companion/lib/devswarm-drain-marker.js');
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
  // 73303d4c098b fix: one-hop redirect through a fold-time retired tombstone
  // (see writeRetiredRedirect's header comment near primaryCursorPath), the
  // read-side mirror of resolveSendTarget's own redirect fix. ONLY applied
  // when `id` genuinely has nothing live backing it any more (no descriptor,
  // no registry row in the repoKey store this caller resolves to) — a
  // redirect record existing is a HINT, never proof the id stayed dead; a
  // caller that re-registered the same id later must see ITS OWN live row,
  // never a stale redirect. Single hop only, same reasoning as the send-side
  // fix: a twice-folded id fails closed exactly as before and `roster`
  // reports the fresh id to retry with.
  let redirectedFromId = null;
  {
    const redirectedTo = readRetiredRedirect(home, id);
    if (redirectedTo && String(redirectedTo) !== String(id) && !readDescriptorFile(home, id)) {
      let hasRegistryRow = false;
      try {
        const probeRepoKey = repoKeyForCwd(ctx);
        const probeStore = store.openStore({ home, workspaceId: id, hash: probeRepoKey || undefined, backend: ctx.backend, env: ctx.env });
        try { hasRegistryRow = (probeStore.listRegistry() || []).some((r) => r && String(r.id) === String(id)); }
        finally { probeStore.close(); }
      } catch (_) { hasRegistryRow = false; }
      if (!hasRegistryRow) {
        redirectedFromId = String(id);
        id = String(redirectedTo);
      }
    }
  }
  // carry-out (e): a REAL session reading this row's mailbox is proof the row
  // is claimed — take the `unclaimed:` marker off before anything below decides
  // liveness from it. Idempotent, fail-soft, and a pure no-op for every row that
  // is not carrying the marker.
  const promotedInner = maybePromoteUnclaimed(home, id, flags, ctx);
  const doAck = inboxReadDoesAck(flags, opts);
  // Phase 5 ack split: `deferAck` = compute the exact ack (same unread window,
  // same caps, same ownership gate) but DO NOT write it — persist it as a read
  // receipt instead (`inbox ack-primary --receipt` applies it after consumption).
  const deferAck = doAck && !!(opts && opts.deferAck);
  let deferredAckOps = null;
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
        + " owner's behalf run `inbox read-primary " + String(id)
        + ' --ack-as-owner`, then the `ackCommand` it returns (`inbox ack-primary ' + String(id)
        + ' --receipt <rid> --ack-as-owner`).\n');
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
  // CALLER INSTANCE IDENTITY (defect 8b211241bbe9). `deriveInstanceNonce` never
  // returns null and is memoized per process, so this is one cheap, stable value
  // per invocation: the same harness session (main thread, a cron turn, a
  // Monitor turn — all children of the same claude process) resolves the SAME
  // nonce, while a genuinely separate process gets its own. Short form only —
  // the raw nonce is process-identifying and never lands in a filename.
  let callerReader = null;
  // `ctx.instanceNonce` is an IN-PROCESS override only — nothing in `run()`'s
  // argv/env parsing ever sets it, so it is not a spoofing surface; it exists
  // because `deriveInstanceNonce` memoizes per process (deliberately), which
  // would otherwise collapse two simulated instances in one test run into one.
  callerReader = callerReaderKey(ctx); // Phase 3: full reader key ('h:<pid>:<startMs>') or null (headless)
  let callerRepoKeyForLog = null;
  try { callerRepoKeyForLog = repoKeyForCwd(ctx); } catch (_) { callerRepoKeyForLog = null; }
  const cursorPath = primaryCursorPath(home, id);
  // Pre-fix value here; re-based onto this instance's own position as soon as
  // the store handle exists (see the PER-INSTANCE READ BASE note below). The
  // early-return refusal branches between here and there only ever report it.
  let cursor = inboxCursor.readCursor(cursorPath);
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
  // D1 fix (namespace split): `inbox count`/`read`/`ack`/`tick` (cmdInbox,
  // below) resolve the NDJSON cursor through resolveNdCursorPath — a
  // PER-INSTANCE file seeded from the descriptor once, then read/written on
  // its own from then on. This verb (read-primary/peek-primary) used to read
  // and ack the RAW descriptor cursor (`desc.cursorPath`) directly instead,
  // so the two verb families advanced two different files: read-primary
  // advanced the descriptor while `tick` kept reading the untouched instance
  // file (a permanent phantom-unread `tick` could never clear), and
  // read-primary's own union — recomputed each call over the ALREADY-ADVANCED
  // descriptor it just wrote — returned `count 0, messages []` on the very
  // next call. Route through the SAME resolver `cmdInbox` uses so both verb
  // families share one cursor; `projectNdDescriptorCursor` (called after the
  // ack below) still projects the MIN across instances onto the descriptor,
  // preserving the invariant that keeps a sibling instance from losing mail.
  // Phase 3: the NDJSON read position is this reader's reader_cursors row
  // (ns 'nd'), never a per-instance file; the descriptor cursor path is kept
  // only for `known` and for the one-release dual-write.
  const ndCursorPath = desc ? desc.cursorPath : null;
  const openedForRead = resolveWorkspaceStoreForRead(id, ctx, home, { skipExistenceGuard: doAck && !ackAsOwner });
  if (!openedForRead.ok) {
    // B3 (defect 1932b53a3ace): a refusal from resolveWorkspaceStoreForRead
    // (e.g. a sibling/twin registry row this caller does not own) used to
    // return the bare `{ ok:false, id, reason, error, ... }` shape with none
    // of the B1 read-side meta fields — a caller checking for
    // repoKey/storePath/known alongside `reason` saw those come back
    // `undefined` (indistinguishable from "every field null"). Merge in the
    // same shared meta every other read-side verb reports, never overriding
    // a `reason`/`error` this refusal already set.
    //
    // fl-wave3 fix: `storeUnavailable` used to be hardcoded `true` for EVERY
    // refusal reason resolveWorkspaceStoreForRead can produce
    // ('project-context-mismatch', 'unregistered-workspace') — but
    // emitKnownWarning treats a truthy `storeUnavailable` as its OWN, highest-
    // priority warning reason (`reasons.push('storeUnavailable' + ...)`),
    // which SWALLOWS the real, more specific `result.reason` (that fallback
    // only fires when `reasons` is still empty). An `unregistered-workspace`
    // refusal — the id simply does not exist yet, nothing about the store
    // being unreadable — then warned the operator with a generic
    // "storeUnavailable" instead of the actual, more actionable reason.
    // `storeUnavailable` is now true ONLY for the literal 'store-unavailable'
    // reason (the shape this file's OTHER read-side merge, ~line 7885, can
    // actually produce); every other refusal reason reports
    // `storeUnavailable:false` and lets emitKnownWarning's own fallback name
    // the real reason instead.
    const failMeta = readSideMeta(ctx, home, null, id, openedForRead);
    const failReason = openedForRead.reason || 'store-unavailable';
    // fl-wave5 fix (item 1): `storeUnavailableReason` defaults to `null` here
    // so it is ALWAYS present (string|null) on this shape, same as every
    // other read verb — `openedForRead` (spread last) still overrides it
    // with the real fs error code when the refusal reason IS
    // 'store-unavailable' (resolveWorkspaceStoreForRead sets that field
    // itself on both of its own store-unavailable branches).
    return Object.assign(
      {
        repoKey: failMeta.repoKey, storePath: failMeta.storePath, cwd: failMeta.cwd,
        meshPartitionIds: [String(id)], known: false, storeUnavailable: failReason === 'store-unavailable',
        storeUnavailableReason: null,
        meshGroupUnresolved: false, meshGroupError: null, totalsPartial: true,
        reason: failReason,
      },
      openedForRead,
    );
  }
  const s = openedForRead.store;
  // PER-INSTANCE READ BASE (defect 8b211241bbe9). Sizing this window from the
  // id-keyed shared file alone is what let one instance's ack hide another
  // instance's unread mail: whichever instance acked first moved the single
  // shared cursor for every reader of that id. `siblingBaseCursor` returns
  // `max(floor, thisInstance)` where `floor` is the MIN across instance files —
  // and, with no instance file yet (bootstrap, and every pre-0.99 install),
  // exactly the pre-fix `max(cursors/<id>.json, store cursor)`.
  cursor = siblingBaseCursor(s, home, id, callerReader);
  let total, messages, acked, union = null;
  // B1: hoisted outside the try{} below (same reasoning as
  // meshGroupUnresolved/meshGroupError just below) so `out`'s meshPartitionIds
  // field, built AFTER the try/finally closes `s`, can see the resolved value
  // instead of the shadowed `let meshPartitionIds` declared INSIDE that try
  // block for the sibling-merge loop's own use.
  let meshPartitionIds = [String(id)];
  // Same reasoning, same hoist: read again below (deferAck's read-receipt
  // dirId resolution) after the try/finally that closes `s`.
  let meshUnionActive = false;
  // 8d0a66cfc563 cap bookkeeping — declared outside the try{} block below (it
  // is read again while building `out`, after the try/finally has closed `s`).
  let withheldBySource = null;
  let truncatedCount = 0;
  // --since-before-cap bookkeeping (defect: --since used to be applied AFTER
  // the per-source read cap, so a recent --since window could be silently
  // emptied by a cap that had already discarded exactly the rows the window
  // asked for). `windowSinceWithheld`/`windowUndated` are hoisted out here
  // (same reasoning as withheldBySource/truncatedCount above) so the early
  // since-filter inside the try{} block and the later --tail stage after it
  // closes can both contribute to the one number reported in `out.window`.
  let windowWithheld = 0;
  let windowUndated = 0;
  let windowSinceWithheld = 0;
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
      // fl-wave8 fix (item 1): resolveMeshTarget -> meshCandidateRows calls
      // storeHandle.listRegistry(), which SWALLOWS a genuine registry.ndjson
      // read failure (EACCES etc — see its own header) down to an empty []
      // rather than throwing. When the store is unreadable this makes
      // `ownEntry` come back null NOT because the caller genuinely has no
      // registry row, but because the read itself failed — and the ownership
      // check below then misreports that as `caller-not-registered`
      // (ownershipRefusalCause's normal "caller resolved fine but is not
      // registered" cause), a security-shaped refusal for what is actually a
      // store outage. Probe getReadError() right after resolveMeshTarget()
      // (the read it just performed is now reflected) and report the GENUINE
      // failure instead, before any ownership reasoning runs.
      let ackReadError = null;
      try { ackReadError = (s.getReadError && s.getReadError()) || null; } catch (_) { ackReadError = null; }
      if (ackReadError) {
        const su = readSideMeta(ctx, home, s, id);
        return {
          ok: false,
          reason: 'store-unavailable',
          error: 'store for workspace ' + JSON.stringify(id) + ' could not be read ('
            + (ackReadError.code || 'EUNKNOWN') + ' on ' + JSON.stringify(ackReadError.path) + ')',
          id,
          callerIdentity: caller,
          identity: { id: caller, kind: callerKind },
          repoKey: su.repoKey, storePath: su.storePath, cwd: su.cwd,
          meshPartitionIds: [String(id)], known: false,
          storeUnavailable: true, storeUnavailableReason: ackReadError.code || 'EUNKNOWN',
          meshGroupUnresolved: false, meshGroupError: null, totalsPartial: true,
        };
      }
      const owns = caller === id || (ownEntry && ownEntry.id === id) || ownsAsDeclaredSelf(s, ctx, id);
      if (!owns) {
        // A7: name WHICH leg failed (same classification as the heartbeat
        // --summary refusal above).
        let cause = ownershipRefusalCause(callerKind, ownEntry);
        // fl-wave3 fix (item 9): ownershipRefusalCause only ever looks at the
        // CALLER's own identity — it has no way to know `id` itself does not
        // exist at all. FIX 5's existence guard (resolveWorkspaceStoreForRead,
        // ~line 6220) is deliberately SKIPPED for this doAck path
        // (`skipExistenceGuard: doAck && !ackAsOwner`) precisely so THIS
        // richer ownership check can run instead — but that means a totally
        // unregistered id (no descriptor, no registry row, no store history)
        // fell all the way through to a caller-identity-shaped reason like
        // 'unresolvable-caller-identity', while `peek-primary`/`count` on the
        // SAME literal id correctly report 'unregistered-workspace'. Check
        // existence HERE (the one place this path was skipped for) so
        // `read-primary`/`inbox messages --ack` agree with every other read
        // verb on the SAME id.
        try {
          const hasOwnDescriptor = !!readDescriptorFile(home, id);
          const hasRegistryRow = (s.listRegistry() || []).some((r) => r && String(r.id) === String(id));
          const hasMessages = s.messageCount(id) > 0;
          if (!hasOwnDescriptor && !hasRegistryRow && !hasMessages) cause = 'unregistered-workspace';
        } catch (_) { /* fail-open: keep the caller-identity-derived cause on any lookup error */ }
        // D11-C (defect 66c7c4e9973e): name the VERB, not a generic "ack" —
        // this refusal fires for `read-primary` (and plain `inbox messages
        // --ack`) alike, both of which DRAIN `id`'s NDJSON cursor same as
        // `inbox ack`'s own refusal does; a caller reading "ack refused" here
        // had no verb to look up and no non-mutating alternative named. Point
        // at `peek-primary` — the actual non-mutating view of the same rows —
        // using the SAME action-label convention this function's own output
        // already uses (`(opts && opts.action) || (doAck ? 'read-primary' :
        // 'messages')`, ~line 6621) so the two never drift apart.
        const verbLabel = (opts && opts.action) || (doAck ? 'read-primary' : 'messages');
        // B3 (defect 1932b53a3ace): a same-worktree TWIN SIBLING row (caller
        // owns a DIFFERENT registered row for this worktree, `ownEntry`
        // truthy) refuses here with `ownership-mismatch` — a real, non-null
        // `reason` string — but this refusal used to carry none of the B1
        // read-side meta (repoKey/storePath/cwd/known/...), so a caller
        // checking those alongside `reason` saw them come back `undefined`.
        const refusalMeta = readSideMeta(ctx, home, s, id);
        return {
          ok: false,
          reason: cause,
          error: verbLabel + ' refused (' + cause + '): it drains ' + JSON.stringify(id)
            + '; use `inbox peek-primary ' + id + '` for a non-mutating view, or --ack-as-owner to override',
          id,
          callerIdentity: caller,
          // D11-A (d35d2d4b241e): ADDITIVE — surface callerIdentityDetailed's
          // `kind` (resolved/declared/unresolvable) alongside the existing
          // `callerIdentity` string, never replacing it.
          identity: { id: caller, kind: callerKind },
          repoKey: refusalMeta.repoKey, storePath: refusalMeta.storePath, cwd: refusalMeta.cwd,
          meshPartitionIds: [String(id)], known: false, storeUnavailable: false, storeUnavailableReason: null,
          meshGroupUnresolved: false, meshGroupError: null, totalsPartial: true,
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
    // B1: reassigns the OUTER (function-scope) meshPartitionIds declared
    // above the try{} — no `let` here, so `out`'s own meshPartitionIds field
    // sees the resolved value instead of a shadowed copy that falls out of
    // scope when this block ends.
    meshPartitionIds = [String(id)];
    meshUnionActive = false;
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
        const pCursor = siblingBaseCursor(s, home, pid, callerReader);
        // Ackability decided BEFORE the window is sized (it was computed after,
        // below) — it now selects the cursor namespace this window is measured
        // against, not just how the cap slices.
        const pAckable = doAck && !siblingAckGate(s, id, pid, home, ctx.now, { cwd: ctx && ctx.cwd, env: ctx && ctx.env });
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
        // Phase 3: the ONE countFor (own reader row, or the floor when headless /
        // undeclared). An UNKNOWN result (store read error) is never a "0
        // store-only unread": drop to the store-only reporting below.
        union = readerCursors.countFor(s, { reader: callerReader, partition: id, inboxPath: desc.inboxPath, cursorPath: ndCursorPath, home, now: ctx && ctx.now });
        if (union && union.unknown) union = null;
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
      ownStoreCursor = union ? union.storeCursor : cursor;
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
    // --since APPLIED BEFORE THE CAP (defect: `inbox messages <id> --since
    // <recent> --limit 2000` returned count:0 on a large inbox — the per-
    // source cap below used to run FIRST and keep only the OLDEST
    // `inboxReadLimit` rows per source; --since was then applied to that
    // already-capped, already-oldest set, so a recent window matched nothing
    // even though `total` proved thousands of matching rows existed. Filter
    // by --since HERE, on the full unand-capped merged set, so the cap below
    // sees (and caps) only the rows that are actually in the requested
    // window. `--tail` deliberately stays out of this early filter — it is
    // handled at its existing later stage, which refuses outright rather
    // than silently mis-answering once truncation has occurred (see the
    // TAIL-UNDER-TRUNCATION REFUSAL comment further down). Never runs for an
    // ack-bearing call: `windowActive` is `!doAck && !forceUnread` (~line
    // 9578), so this can only touch the non-mutating `inbox messages` read.
    if (windowActive && windowSince && Array.isArray(messages)) {
      const beforeSince = messages.length;
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
      windowSinceWithheld = beforeSince - messages.length;
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
      // Direction depends on whether this call advances a cursor. `doAck`
      // calls (read-primary/ack) MUST keep the OLDEST rows as a genuine
      // structural prefix per source — the ack-cursor math below depends on
      // a withheld row's cursor never advancing past it (see the header
      // comment above this block). A non-acking call (`doAck` false — plain
      // `inbox messages`) writes no cursor, so that constraint does not
      // apply, and defaulting to the oldest rows was itself part of this
      // defect: a caller near a large, old inbox got 1959 rows from months
      // ago with no indication recent mail existed. Keep the NEWEST rows
      // (a genuine structural SUFFIX per source, same provable-by-__srcIdx
      // construction, mirrored) instead.
      // peek-primary (forceUnread) is the non-mutating preview of what
      // read-primary will deliver, so it keeps the same OLDEST prefix; only a
      // plain `inbox messages` read switches to the newest suffix.
      const keepOldest = doAck || forceUnread;
      const naiveKept = new Set(keepOldest ? messages.slice(0, inboxReadLimit) : messages.slice(-inboxReadLimit));
      const minWithheldIdxBySource = new Map(); // keepOldest: earliest withheld __srcIdx per source
      const maxWithheldIdxBySource = new Map(); // !keepOldest: latest withheld __srcIdx per source
      for (const row of messages) {
        if (!row || row.__srcId === undefined) continue;
        if (naiveKept.has(row)) continue;
        if (keepOldest) {
          const cur = minWithheldIdxBySource.has(row.__srcId) ? minWithheldIdxBySource.get(row.__srcId) : Infinity;
          if (row.__srcIdx < cur) minWithheldIdxBySource.set(row.__srcId, row.__srcIdx);
        } else {
          const cur = maxWithheldIdxBySource.has(row.__srcId) ? maxWithheldIdxBySource.get(row.__srcId) : -Infinity;
          if (row.__srcIdx > cur) maxWithheldIdxBySource.set(row.__srcId, row.__srcIdx);
        }
      }
      const kept = [];
      withheldBySource = new Map();
      for (const row of messages) {
        let withhold;
        if (keepOldest) {
          const minIdx = (row && row.__srcId !== undefined && minWithheldIdxBySource.has(row.__srcId))
            ? minWithheldIdxBySource.get(row.__srcId) : Infinity;
          withhold = !!(row && row.__srcIdx !== undefined && row.__srcIdx >= minIdx);
        } else {
          const maxIdx = (row && row.__srcId !== undefined && maxWithheldIdxBySource.has(row.__srcId))
            ? maxWithheldIdxBySource.get(row.__srcId) : -Infinity;
          withhold = !!(row && row.__srcIdx !== undefined && row.__srcIdx <= maxIdx);
        }
        if (withhold) {
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
      // PER-INSTANCE ACK (defect 8b211241bbe9). The pre-fix pair here was
      // `ackTo(cursorPath, ownTarget)` + `s.setCursor(id, acked)` — BOTH write
      // the id-keyed shared namespace, and THAT is the defect: a second
      // instance of the same id (a twin row, a resumed session) had its mail
      // consumed by whichever instance acked first. `commitInstanceAck` records
      // this instance's own position and moves the shared pair only to the MIN
      // across instances, so a lagging peer is never skipped. With a single
      // instance the min IS this instance's value, making the shared pair
      // byte-identical to the pre-fix behavior.
      // `delivered` MUST be the rows this call actually returned for `id`'s own
      // partition. Gating on `wantsUnion || meshUnionActive` was wrong: `doAck`
      // alone sets `wantsUnion`, but with no descriptor inbox the union never
      // runs and NO row is ever tagged — so a store-only read that delivered 3
      // rows journaled `delivered: 0`, a false positive of the exact signature
      // this journal exists to make trustworthy (caught by test).
      //
      // Count by what a row IS, not by which flag was set: a sibling row always
      // carries `__srcId: 'sibling:<id>'`, so `id`'s own rows are the ones
      // tagged 'own' PLUS the untagged ones from the store-only path.
      const ownDeliveredCount = messages.filter(
        (r) => r && (r.__srcId === undefined || r.__srcId === 'own')
      ).length;
      // Phase 5 ack split: the ack is COLLECTED as ops (own / sibling / nd),
      // then either applied right here (legacy same-call drain) or persisted
      // in a read receipt that `inbox ack-primary --receipt` applies later.
      // ONE executor (applyReadAckOps) for both, so they cannot drift.
      const ackOps = [{ k: 'own', partition: String(id), target: ownTarget, delivered: ownDeliveredCount }];
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
        const notAckable = siblingAckGate(s, id, part.id, home, ctx.now, { cwd: ctx && ctx.cwd, env: ctx && ctx.env });
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
        ackOps.push({
          k: 'sibling', partition: String(part.id), ackTarget,
          seenTarget: (Number.isFinite(part.sinceCursor) ? part.sinceCursor : part.cursor) + physicalConsumed,
          notAckable: !!notAckable,
          delivered: Number.isFinite(part.deliveredCount) ? part.deliveredCount : null,
        });
      }
      // NDJSON descriptor channel (a THIRD cursor, the reader_cursors 'nd' row).
      // defect 8d0a66cfc563: ack only up to what was delivered (union.cursor +
      // kept ndjson lines), so withheld lines resurface as unread next read.
      if (union && desc && desc.inboxPath && desc.cursorPath) {
        const ndjsonWithheldCount = withheldBySource ? (withheldBySource.get('ndjson') || 0) : 0;
        ackOps.push({
          k: 'nd', partition: String(id),
          target: union.cursor + union.ndjsonUnreadLines.length - ndjsonWithheldCount,
          cursorPath: desc.cursorPath, inboxPath: desc.inboxPath,
        });
      }
      if (deferAck) {
        deferredAckOps = ackOps;
      } else {
        const applied = applyReadAckOps(s, home, id, callerReader, ackOps, {
          ctx, repoKey: callerRepoKeyForLog, verb: 'read-primary', revalidate: false,
        });
        for (const f of applied.failures) cursorWriteFailures.push(f);
        acked = applied.acked;
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
  // WINDOW PROJECTION (--since / --tail, defect 3f6027ee462a), ONLY on the
  // non-acking `inbox messages` verb (windowActive is false everywhere else —
  // the ack-bearing verbs already returned a rejection above). Nothing here
  // touches a cursor, a total, or an ack: `total`/`unreadCount` below keep
  // reporting the REAL untruncated figures, and the withheld rows are still
  // exactly where they were. --since itself is now applied EARLY, before the
  // per-source cap (see the "--since APPLIED BEFORE THE CAP" block above) —
  // `windowSinceWithheld`/part of `windowUndated` were already accumulated
  // there; only --tail's slice (which must run after the cap; it refuses
  // outright rather than risk a wrong answer, below) still happens here.
  // Rows with no comparable field (`ts`/`index` null — a legacy row) are KEPT
  // by --since rather than dropped: hiding mail because its metadata is missing
  // is the one failure mode a "show me recent mail" flag must never have. They
  // are counted in `windowUndated` so the caller can see it happened.
  windowWithheld = windowSinceWithheld;
  if (windowActive && Array.isArray(messages)) {
    // TAIL-UNDER-TRUNCATION REFUSAL (R11-A3, P2). `--tail N` promises "the
    // NEWEST N". Once the per-source read cap above has fired (truncatedCount
    // > 0), refuse rather than guess: this verb is non-acking (windowActive
    // is false whenever doAck is set), so nothing has been consumed and
    // re-running with `--since` (which now narrows the set BEFORE the cap
    // can bite — see above) returns the mail. No mail is ever lost by
    // refusing here.
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
          + inboxReadLimit + '-row per-source cap (' + truncatedCount + ' row(s) withheld).',
        hint: 'use `--since <index|ISO date>` to bound the read to recent mail before the cap applies '
          + '(or raise --limit above ' + inboxReadLimit + ' so nothing is truncated). Nothing was acked; no mail was lost.',
      };
    }
    const before = messages.length;
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
    windowWithheld += before - messages.length;
  }
  // FORWARDED-ROW MARKER (defect e9e7c99ec924, P2): a forward preserves the
  // ORIGINAL row's `ts` verbatim (MESH_ROW_COPY_FIELDS, ~line 1432) while
  // `storeSeq` is freshly assigned at forward time — by design (the forward IS
  // the original message, re-addressed; renumbering `ts` would misrepresent
  // when it was actually sent). That design is silent to a reader: `read-
  // primary`/`inbox messages` printed a forwarded row's out-of-order timestamp
  // with nothing marking it as a forward, reading as corrupt ordering rather
  // than the documented copy semantics. `forwardedOrigHashOf` is the SAME
  // helper the dedup/gap-fold paths already use to detect a forward (handles
  // both the `origHash`-stamped case and the legacy prefix-reconstruction
  // case) — additive only: never renumbers `seq`/rewrites `ts`, never mutates
  // the source row objects (a fresh shallow copy per message).
  messages = Array.isArray(messages) ? messages.map((m) => {
    const origHash = forwardedOrigHashOf(m);
    let out2 = origHash ? Object.assign({}, m, { forwarded: true, origHash }) : m;
    // instanceNonce CONSUMER (defect d3d571495bf6, `inbox read-primary`/`inbox
    // messages`): a row without instanceNonce renders EXACTLY as before this
    // fix — no new keys, byte-identical output. A row that DOES carry one gets
    // two purely additive fields: `instanceNonceShort` (the shared short digest
    // every consumer below uses, see shortInstanceNonce's own header) and
    // `fromLine` — the human-readable rendering of the sender for a reader
    // eyeballing this JSON, `<senderId>@<short>`, so two live processes both
    // claiming the same sender id are visibly distinguishable per message
    // instead of reading as one indistinguishable sender.
    const short = out2 && out2.instanceNonce ? shortInstanceNonce(out2.instanceNonce) : null;
    if (short) {
      out2 = Object.assign({}, out2, {
        instanceNonceShort: short,
        fromLine: (out2.sender != null ? String(out2.sender) : '') + '@' + short,
      });
    }
    // D4 fix (content-blind ack): the ack above (see ndCursorPath/desc.cursorPath
    // writes and the store-side ack) fires in the SAME call that emits `messages`
    // — nothing here truncates a body (every cap in this file is row-count, not
    // byte-count), but a consumer DOWNSTREAM of this CLI's stdout (a tool-output
    // limit, a hook renderer, `tail -c`) can still clip bytes after the cursor
    // has already moved, with no way for the caller to tell. Additive per-row
    // `bodyLength` (UTF-8 byte length, matching how a byte-based clip would cut)
    // lets a clipped consumer self-detect a short read by comparing what it
    // actually received against this field.
    // Normalized, additive row shape shared with `mesh read` broadcasts: every row
    // carries `from`, `text`, `kind` ('broadcast'|'direct') alongside the legacy
    // `sender`/`body` keys (kept for backward compatibility).
    out2 = Object.assign({}, out2, {
      from: out2 && out2.sender != null ? out2.sender : null,
      text: out2 && out2.body != null ? out2.body : '',
      kind: out2 && out2.mtype === 'broadcast' ? 'broadcast' : 'direct',
    });
    out2 = Object.assign({}, out2, { bodyLength: Buffer.byteLength(out2 && out2.body != null ? String(out2.body) : '', 'utf8') });
    return out2;
  }) : messages;
  // `--with-broadcasts` (non-acking `inbox messages` only): merge the project's
  // shared broadcasts into the row list, tagged kind:'broadcast', ordered by
  // store `seq` (newest 50). Opt-in so the default shape for existing consumers
  // is unchanged. Rows are read-only copies: no cursor moves.
  let broadcastsMerged = null;
  if (hasFlag(flags, 'with-broadcasts') && !doAck && typeof s.listMessages === 'function') {
    let aliasesB = {};
    try { aliasesB = require('../../companion/lib/devswarm-sender-alias.js').readAliases(home); } catch (_) { aliasesB = {}; }
    const bc = s.listMessages(store.BROADCAST_PARTITION_ID)
      .filter((r) => !r.isHeartbeat && Number.isFinite(r.storeSeq))
      .slice(-50)
      .map((r) => {
        const a = r.sender != null ? aliasesB[String(r.sender)] : null;
        const from = a ? a.to : r.sender;
        return { from, sender: from, text: r.body, body: r.body, message: r.body, kind: 'broadcast', mtype: 'broadcast', ts: r.ts, timestamp: r.ts, urgency: r.urgency, seq: r.storeSeq, storeSeq: r.storeSeq, bodyLength: Buffer.byteLength(String(r.body == null ? '' : r.body), 'utf8') };
      });
    broadcastsMerged = bc.length;
    messages = (Array.isArray(messages) ? messages : []).concat(bc)
      .sort((x, y) => (Number(x && x.seq) || 0) - (Number(y && y.seq) || 0));
  }
  // Mesh message triage (Jev, part 2) — ADVISORY ONLY, purely additive. Every
  // row above is UNCHANGED by this step; a row this call could not confidently
  // classify (disabled, low confidence, or any failure) simply never gains a
  // `triage` key — byte-identical to before this feature existed. Never
  // suppresses/reorders/delays a row and never touches `unreadCount`/`cursor`/
  // `total` above, all already computed. See hooks/lib/jev-triage.js.
  if (Array.isArray(messages) && messages.length) {
    try {
      const jevTriageLib = require('../../hooks/lib/jev-triage.js');
      const { triageMessagesSync } = jevTriageLib;
      const items = messages.map((m, i) => ({ key: i, text: m && m.body != null ? String(m.body) : '' }));
      const labels = triageMessagesSync(items, { home });
      if (labels.size) {
        messages = messages.map((m, i) => {
          const label = labels.get(i);
          if (label) {
            // JEV outcome tracking (best-effort, fail-open): remember that
            // `id` (this reader) received a labeled message from m.sender,
            // so a later cmdSend(from: id, to: sender) can log the
            // time-to-answer. Never affects the returned row.
            try { jevTriageLib.noteLabeledInbound({ home, recipient: id, sender: m && m.sender, label }); } catch (_) {}
          }
          return label ? Object.assign({}, m, { triage: label }) : m;
        });
      }
    } catch (_) {
      // triage is advisory-only: any failure here must never affect the read.
    }
  }
  // B1 (defects 902d3c5e7531/1932b53a3ace): repoKey/storePath/cwd + the
  // withheld-state fields, same shared shape `inbox count`/`read` report —
  // `messages`/`read-primary`/`peek-primary` used to omit all of these.
  const msgMeta = readSideMeta(ctx, home, s, id);
  // fl-wave4 fix (item 2): a store that WAS openable but hit a genuine
  // read error somewhere along this call's own pipeline (meshCandidateRows'
  // listRegistry(), the message-history reads above, etc — all against this
  // SAME handle `s`) must not fold silently into `known:true` the way
  // `storeUnavailable: false` (hardcoded, pre-fix) always did for this verb
  // family. Probed HERE (a getter, not a new read) so this reports the SAME
  // storeUnavailable/known shape `inbox count`/`read` already carry for the
  // identical underlying condition.
  let msgReadError = null;
  try { msgReadError = (s.getReadError && s.getReadError()) || null; } catch (_) { msgReadError = null; }
  const msgStoreUnavailable = msgReadError
    ? { reason: 'store-unavailable', storeUnavailableReason: msgReadError.code || 'EUNKNOWN', error: null, registeredRepoKey: null, callerRepoKey: null }
    : false;
  const out = {
    ok: true,
    action: (opts && opts.action) || (doAck ? 'read-primary' : 'messages'),
    id,
    repoKey: msgMeta.repoKey, storePath: msgMeta.storePath, cwd: msgMeta.cwd,
    meshPartitionIds,
    unreadOnly,
    unreadCount,
    cursor: acked !== undefined ? acked : cursor,
    total: outTotal,
    count: messages.length,
    messages,
    // D4 fix: payload-level total (sum of every row's `bodyLength` above) so a
    // consumer that only sees a byte-clipped tail of this JSON can compare the
    // bytes it actually received against what this call claims to have sent,
    // and self-detect the clip. `truncatedBodyHint` (recovery path, additive,
    // always present) — this call already ACKED whatever it delivered (see the
    // ndCursorPath/store acks above), so a clip does not lose mail: acked rows
    // stay re-servable, read-only and not unread-scoped, via `inbox messages
    // <id>` (optionally `--since`).
    totalBodyBytes: messages.reduce((sum, m) => sum + (Number.isFinite(m && m.bodyLength) ? m.bodyLength : 0), 0),
    truncatedBodyHint: 'if this JSON looks shorter than `totalBodyBytes`/per-row `bodyLength` implies, '
      + 'the OUTPUT (not the ack) was clipped downstream — already-acked mail is still re-readable, '
      + 'read-only and not unread-scoped, via: inbox messages ' + id + ' (optionally --since)',
    known: readSideKnown(true, { storeUnavailable: msgStoreUnavailable, meshGroupUnresolved, meshGroupError }),
    ...storeUnavailableOut(msgStoreUnavailable),
    meshGroupUnresolved: !!meshGroupUnresolved,
    meshGroupError: meshGroupError || null, totalsPartial: !!meshGroupUnresolved,
    ...(msgStoreUnavailable ? { unreadStoreUnknown: true } : {}),
  };
  if (broadcastsMerged !== null) out.broadcastCount = broadcastsMerged;
  else if (hasFlag(flags, 'with-broadcasts') && doAck) out.withBroadcastsIgnored = 'acking verb; use `inbox messages <id> --with-broadcasts` (non-acking)';
  // 73303d4c098b fix: surface the redirect so a caller addressing the OLD
  // (now-folded) id sees it landed on the survivor instead of silently
  // getting someone else's mailbox with no explanation.
  if (redirectedFromId) { out.redirected = true; out.redirectedFrom = redirectedFromId; }
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
  if (doAck && !deferAck) {
    out.ackedFrom = cursor;
    out.acked = acked;
  }
  // Phase 5 ack split: nothing was acked. Persist the exact ack as a read
  // receipt and hand the caller ONE command to run after consuming the mail.
  if (deferAck) {
    // Identity/alias-family canonical dir (see canonicalReceiptId): reuses
    // the mesh resolution already computed above for this same read
    // (meshPartitionIds/meshUnionActive) rather than re-resolving it, so a
    // receipt written for `id` can also be found + acked through any OTHER
    // alias in the same family (e.g. a DevSwarm-native builder-id UUID row
    // vs anti-hall's own minted primary-<hash> row on the same worktree).
    const receiptDirId = (meshUnionActive && Array.isArray(meshPartitionIds) && meshPartitionIds.length > 1)
      ? meshPartitionIds.slice().sort()[0]
      : String(id);
    const rec = writeReadReceipt(home, id, {
      reader: callerReader, ops: deferredAckOps || [], now: ctx.now,
      hashes: messages.map((m) => (m && m.hash != null ? String(m.hash) : null)),
      dirId: receiptDirId,
    });
    out.acked = false;
    if (rec.ok) {
      out.readReceiptId = rec.receiptId;
      out.ackCommand = 'node ' + JSON.stringify(resolveStableCliPath(home, CLI_PATH)) + ' inbox ack-primary ' + id + ' --receipt ' + rec.receiptId;
      out.ackHint = 'read-only: nothing was acked. After you have consumed these messages run ackCommand '
        + '(advances exactly what this read returned; re-reading before the ack returns the same unread set).';
    } else {
      out.readReceiptId = null;
      out.receiptError = rec.error;
      out.ackHint = 'read-only: nothing was acked, and the read receipt could not be written (' + rec.error
        + ') — re-run read-primary, or use `inbox drain-primary-legacy ' + id + '` to read-and-ack in one call.';
    }
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

module.exports = {
  readSideMeta, readSideKnown, isGenuineStoreUnavailableReason, storeUnavailableOut,
  resolveReadArgToId, cwdInsideRegisteredWorktree, resolveWorkspaceStoreForRead,
  DEFAULT_INBOX_READ_LIMIT, NEVER_READ_SIBLING_CAP, INBOX_WINDOW_FLAGS, inboxWindowRejection,
  parseInboxSince, inboxReadDoesAck, cmdInboxMessages, cmdInboxMessagesInner,
};
