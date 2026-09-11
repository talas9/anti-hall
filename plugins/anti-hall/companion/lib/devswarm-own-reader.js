#!/usr/bin/env node
// anti-hall :: devswarm-own-reader — shared PER-READER unread projection helper.
//
// Fixes defect f061789267c1 / a77b85571dfa (P0): devswarm-store.js's
// computeSummary() sizes `workspaces[id].unread` from `total - cursorValue(id)`,
// where `cursorValue(id)` is the SHARED pair — since 0.99.0's per-instance-cursor
// fix (defect 8b211241bbe9) that shared pair deliberately tracks the MIN across
// every live `<id>#inst-<nonce>` file, so no reader's mail is ever lost. That
// min-floor is correct for the shared pair's own cross-instance-safety contract,
// but it is WRONG for a PER-READER display: "how much unread mail does THIS
// reader (this session) still have" must be measured against THIS reader's own
// instance cursor, not the slowest sibling's. A sibling instance file is
// routinely still present (evicted only after devswarm.js's 7-day
// gcInstanceCursors window — well inside any ordinary multi-day gap), so a
// reader that has genuinely drained everything can be shown a large phantom
// unread count borrowed from a stale/slower sibling. Live proof (2026-09):
// a fresh reader's own `#inst-` file at 929, a 3-day-old sibling file at 859,
// `total:930` -> shared cursor 859 -> summary `unread` 71, though the fresh
// reader's true position (929) leaves only 1 row unread. A cheaper GC cadence
// does NOT fix this: the stale file sits inside the SAME 7-day eviction window
// no matter how often GC runs (see this repo's own-reader test suite's
// "GC cadence does not fix it" case — a standing proof against re-proposing
// that shortcut).
//
// USED BY: hooks/devswarm-parent-gate.js (Stop-hook turn-end gate),
// hooks/devswarm-parent-inbox.js (roster/"Primary's OWN inbound unread"
// segment), and hooks/devswarm-child-turn.js (per-turn mesh-direct nudge) —
// each projects the CALLING reader's OWN row (the Primary's `primary-<hash>`
// row, or a child's own builder-id row) from the SAME shared
// summaries/<repoKey>.json and all three need the SAME per-reader
// correction. Factored ONE place so these surfaces can never drift apart on
// this math again.
//
// NOT for other rows: a summary entry for a CHILD workspace (any id other than
// the caller's own primary-<hash> row) is a MONITORING signal, not a read
// position of this process's own — the Primary isn't "reading" a child's
// mailbox via an instance cursor, it is asking "has this child (any of ITS OWN
// readers) drained its mail", for which the min-floor is the conservative and
// CORRECT answer. Only the reader's own row gets this correction.
//
// AMBIGUOUS-BRANCH LIVE RESOLUTION (P1 GO-with-fix, Critic 2026-09-11, on the
// STALE-CACHE GUARD below). `entry.total`/`entry.cursor` are a CACHED
// SNAPSHOT (computeSummary's last run, written to summaries/<repoKey>.json);
// `ownCursor` is read LIVE (the instance-cursor file at call time). Once
// `ownCursor >= entry.total` — OR `entry.total` is missing/non-finite at all
// (an entry shape this module cannot even evaluate the common path against) —
// the cache can no longer distinguish "reader has
// genuinely drained everything" from "cache predates new arrivals this
// reader has not actually seen" — the exact reporter shape (own 930, cached
// total 930, stale sibling 859) hits this. Returning UNKNOWN there is honest
// but leaves that reporter's gate blocked forever on a healthy summary — not
// finished. So this ONE branch (never the common path) pays for ONE live
// store read to settle it for real: `store.messageCount(id)` (the live row
// count, never any cursor) minus `siblingBaseCursor` (this reader's own live
// store-cursor base — the SAME primitive `inbox count`/`read`/`ack` already
// trust), then folded through `devswarm-unread.js`'s `unionUnread` (store ∪
// durable NDJSON, deduped) ONLY when this row actually has a durable NDJSON
// inbox — never a second implementation of that arithmetic. A row with none
// (the common case for a store-only self-registered row, e.g. the Primary's
// own `primary-<hash>` entry — see this module's USED BY section) resolves
// from the store side alone; `unionUnread`'s own `known` flag is deliberately
// NOT the success signal here, since it reports NDJSON resolvability, which
// is routinely and correctly false for exactly this row shape. A drained
// reader with a lagging sibling resolves to 0; a
// reader behind genuinely-new mail resolves to the real count. Any failure
// in this branch (store won't open, repoKey unresolvable, a read throws)
// still returns UNKNOWN — the live read either PROVES the number or it does
// not run at all; it never guesses.
//
// ownReaderDelta(home, cwd, id, entry) -> { delta, stale, live }.
//   - The COMMON path (ownCursor < entry.total, cache-consistent): `stale`
//     false, `delta` the genuine subtraction, `live` undefined.
//   - Every PRE-EXISTING fail-open path (no instance file yet, nonce-
//     derivation failure, an old-shape entry with no `cursor` field): `stale`
//     false, `delta` 0, `live` undefined — BYTE-IDENTICAL to this function's
//     pre-P1 behavior for those cases.
//   - The AMBIGUOUS branch, live read SUCCEEDS: `stale` false, `live` the
//     live-resolved unread count (definitive, bypasses `delta` entirely).
//   - The AMBIGUOUS branch, live read FAILS/unavailable: `stale` true,
//     `live` undefined — caller MUST treat as UNKNOWN.
function ownReaderDelta(home, cwd, id, entry) {
  if (!entry || !Number.isFinite(entry.cursor)) return { delta: 0, stale: false };
  try {
    // Lazy require (side-effect-free — scripts/devswarm.js is guarded by
    // require.main === module for its CLI body; this repo already has the
    // same lazy-self-require precedent at multiple hook call sites).
    const devswarmCli = require('../../scripts/devswarm.js');
    const { readCursor } = require('./devswarm-inbox-cursor.js');
    const nonce = devswarmCli.deriveInstanceNonce({ home, cwd });
    const shortNonce = devswarmCli.shortInstanceNonce(nonce);
    const instPath = shortNonce ? devswarmCli.instanceCursorPath(home, id, shortNonce) : null;
    if (!instPath) return { delta: 0, stale: false };
    const fs = require('fs');
    if (!fs.existsSync(instPath)) return { delta: 0, stale: false }; // no instance file yet: newcomer starts AT the floor (siblingBaseCursor's own contract) -> delta 0
    const ownCursor = readCursor(instPath);
    if (!Number.isFinite(ownCursor) || ownCursor <= entry.cursor) return { delta: 0, stale: false };
    // Only a FINITE entry.total can prove the cache is current; an entry
    // missing/non-finite `total` (should not happen on a real summary, but
    // this module never trusts shape it hasn't checked) routes into the same
    // ambiguous-branch resolution below — "cannot prove the cache is
    // current" is the same as "cannot trust it without checking live".
    if (Number.isFinite(entry.total) && ownCursor < entry.total) {
      return { delta: ownCursor - entry.cursor, stale: false };
    }
    // AMBIGUOUS BRANCH: resolve with one live read, confined here only.
    try {
      const devswarmUnread = require('./devswarm-unread.js');
      const storeHandle = devswarmUnread.openStoreForUnread({ worktreePath: cwd, id, home });
      if (!storeHandle) return { delta: 0, stale: true };
      try {
        // Resolve the STORE side directly (never trust `unionUnread`'s own
        // `known` flag as the success signal here — that flag reports
        // whether the DURABLE NDJSON side is resolvable, which is routinely
        // false for exactly the row this whole module exists to fix: the
        // Primary's own store-only self-registered row has no inboxPath/
        // cursorPath at all by design (see this module's own header and
        // devswarm-parent-gate.js's readOwnUnread doc comment) — treating
        // that as "the live read failed" would make this branch NEVER
        // resolve for its primary real-world case). `liveTotal`/`liveBase`
        // are read straight off the open handle; any throw here is caught
        // by the outer try below and fails to UNKNOWN, never a guess.
        const liveTotal = storeHandle.messageCount(id);
        const liveBase = devswarmCli.siblingBaseCursor(storeHandle, home, id, shortNonce);
        if (!Number.isFinite(liveTotal) || !Number.isFinite(liveBase)) return { delta: 0, stale: true };
        // A durable NDJSON inbox for this row (rare for a store-only self-
        // registered row, routine for a descriptor-backed one) is folded in
        // for full precision — the SAME union `inbox count`/`read`/`ack`
        // already compute, never a second implementation of that math.
        let liveUnread = Math.max(0, liveTotal - liveBase);
        if (entry.inboxPath || entry.cursorPath) {
          const union = devswarmUnread.unionUnread({
            inboxPath: entry.inboxPath || null, cursorPath: entry.cursorPath || null,
            id, storeHandle, storeBaseCursor: liveBase,
          });
          // MAX, never a bare adopt (Critic P2, 2026-09-11 round 3):
          // `unionUnread` is fail-open — if `listMessages` throws inside it
          // (its own catch, devswarm-unread.js ~:288), it silently degrades
          // to NDJSON-only reporting with `storeOnlyUnreadRows: []`, and its
          // returned `union.unread` would then be LOWER than the store
          // number we already proved live (`liveUnread` above) — adopting
          // it unconditionally would HIDE mail on exactly this failure mode.
          // `Math.max` is safe BY CONSTRUCTION when the store side succeeds:
          // the union is store-only-unread ∪ NDJSON-unread, deduped — dedup
          // only ever COLLAPSES a message already counted once on the store
          // side with its NDJSON twin, it never REMOVES a message the store
          // side alone did not already count. So a successful union can only
          // be >= the store-only count, never <. Do not "simplify" this back
          // to a bare adopt — that is precisely the regression this comment
          // exists to prevent.
          if (union && Number.isFinite(union.unread)) liveUnread = Math.max(liveUnread, union.unread);
        }
        return { delta: 0, stale: false, live: liveUnread };
      } finally {
        try { storeHandle.close(); } catch (_) {}
      }
    } catch (_) {
      return { delta: 0, stale: true };
    }
  } catch (_) {
    return { delta: 0, stale: false }; // fail-open: never worse than the pre-fix (min-floor) number
  }
}

// ownReaderUnread(home, cwd, id, entry, rawUnread) -> the resolved unread
// count (live-resolved when the ambiguous branch fired, else
// Math.max(0, rawUnread - delta)), or `null` when neither could be trusted.
// `rawUnread` is the caller's already-resolved raw count (entry.unread, or
// entry.directUnread with its own alias fallback — callers differ slightly in
// which field they prefer, so this takes the resolved number rather than
// re-deriving it) so this helper stays a pure, single-purpose projection.
//
// `null` is a DELIBERATE, distinct return from every numeric value this
// function can otherwise produce (always >= 0) — every caller MUST check for
// it explicitly and treat it as UNKNOWN, never coerce it (e.g. `|| 0`) into a
// silent zero. See each call site's own comment for how it fails safe.
function ownReaderUnread(home, cwd, id, entry, rawUnread) {
  const raw = Number.isFinite(rawUnread) && rawUnread > 0 ? rawUnread : 0;
  if (raw <= 0) return 0;
  const { delta, stale, live } = ownReaderDelta(home, cwd, id, entry);
  if (live !== undefined) return live;
  if (stale) return null;
  return delta > 0 ? Math.max(0, raw - delta) : raw;
}

module.exports = { ownReaderDelta, ownReaderUnread };
