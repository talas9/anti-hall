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
// PHASE 3 (reader_cursors): the caller's OWN position is its reader row in the
// store's reader_cursors table (ns 'store'), keyed by the nearest harness
// ancestor (reader-identity.js) — no per-instance file any more. A headless
// caller (null nonce) or a reader with no row reads the floor, which IS the
// summary's own base, so its delta is 0 (same as the pre-fix "no instance file"
// path). Any failure to open/read the store keeps the pre-existing contract:
// the common path fails OPEN (delta 0), the ambiguous branch returns UNKNOWN.
function ownReaderDelta(home, cwd, id, entry) {
  if (!entry || !Number.isFinite(entry.cursor)) return { delta: 0, stale: false };
  try {
    const devswarmCli = require('../../scripts/devswarm.js');
    const readerCursors = require('./reader-cursors.js');
    const reader = readerCursors.readerKey(devswarmCli.deriveReaderNonce({ home, cwd }));
    if (!reader) return { delta: 0, stale: false };
    const devswarmUnread = require('./devswarm-unread.js');
    const storeHandle = devswarmUnread.openStoreForUnread({ worktreePath: cwd, id, home });
    // A summary entry with a cursor came FROM a store; if that store cannot be
    // opened now (repo gone, unreadable), this reader's own position is
    // unknowable — UNKNOWN, never a guessed number.
    if (!storeHandle) return { delta: 0, stale: true };
    try {
      let rows;
      try { rows = storeHandle.readerCursorRows(id); } catch (_) { return { delta: 0, stale: true }; }
      const own = rows.find((r) => r.ns === 'store' && r.reader === reader);
      if (!own) return { delta: 0, stale: false }; // undeclared: reads AT the floor -> delta 0
      const ownCursor = own.value;
      if (!Number.isFinite(ownCursor) || ownCursor <= entry.cursor) return { delta: 0, stale: false };
      if (Number.isFinite(entry.total) && ownCursor < entry.total) {
        return { delta: ownCursor - entry.cursor, stale: false };
      }
      // AMBIGUOUS BRANCH (own >= cached total): settle with ONE live countFor
      // for this reader — the SAME primitive every gate/CLI uses. Unknown stays
      // unknown; it never becomes a guessed number.
      const c = readerCursors.countFor(storeHandle, {
        reader, partition: id, inboxPath: entry.inboxPath || null, cursorPath: entry.cursorPath || null, home,
      });
      if (c.unknown || !Number.isFinite(c.unread)) return { delta: 0, stale: true };
      // MAX with the proven store-side count (total - own row): a union can
      // only COLLAPSE store rows with their NDJSON twins, never remove a row the
      // store side alone counts, so a union below it is a degraded read and
      // must never hide mail (Critic P2, 2026-09-11 — kept through Phase 3).
      let liveUnread = c.unread;
      try {
        const liveTotal = storeHandle.messageCount(id);
        if (!Number.isFinite(liveTotal)) return { delta: 0, stale: true };
        liveUnread = Math.max(liveUnread, Math.max(0, liveTotal - ownCursor));
      } catch (_) { return { delta: 0, stale: true }; }
      return { delta: 0, stale: false, live: liveUnread };
    } finally {
      try { storeHandle.close(); } catch (_) {}
    }
  } catch (_) {
    return { delta: 0, stale: false }; // fail-open: never worse than the pre-fix (floor) number
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
