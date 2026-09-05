'use strict';
// anti-hall :: devswarm-unread — the shared LOSS-FREE UNION unread primitive.
//
// ROOT CAUSE this closes (SkyCrew field incident, see this repo's fix-wave
// notes): a Primary's `send --to <id>` (scripts/devswarm.js cmdSend) is a
// STORE-ONLY write — it never touches the target's durable NDJSON inbox,
// which is populated ONLY by `inbox pull` draining the native hivecontrol
// queue. Every reader that checked ONLY the durable NDJSON (liveness's
// unreadBacklog, the child Stop gate, the parent Stop gate) was therefore
// BLIND to a mesh-direct backlog — unread could climb (14 -> 15) while every
// enforcing gate read 0.
//
// This module is the ONE place that computes the union (NDJSON unread ∪
// store-only unread, deduped by content hash so a native-drained message
// already counted on the NDJSON side is never double-counted). Extracted
// verbatim from scripts/devswarm.js's cmdInbox count/read/ack union logic
// (the CLI now delegates here too — byte-identical output) so hooks +
// liveness.js + the CLI share ONE implementation instead of three drifting
// copies.
//
// FAIL-OPEN CONTRACT: `unionUnread` NEVER throws. Any error while reading the
// (caller-supplied, already-opened) store handle falls back to NDJSON-only
// reporting — matching the CLI's pre-fix behavior on a store-open failure.
// Store lifecycle (open/close) is the CALLER's responsibility — some callers
// (a mutating `inbox ack`) need the handle to outlive this call.

const fs = require('fs');
const crypto = require('crypto');
const { readUnread } = require('./devswarm-inbox-cursor.js');

// legacyLineHash(id, index, line) — THE canonical dedupe hash for one physical
// legacy inbox line. companion/devswarm-migrate.js re-exports this exact
// function (it used to own it) rather than keeping a second copy: the two must
// agree byte-for-byte or the dedup below silently stops matching.
//
// WHY THE UNION NEEDS IT (defect 8f2aec40e2ff, found while unifying
// computeSummary onto this primitive): the dedup between the NDJSON side and
// the store side was keyed ONLY on a line's embedded `_h`, which exists only on
// rows written by devswarm-pull.js. A LEGACY line (a bare pre-store inbox
// message, or any line migrate imported) has no `_h` at all — so its migrated
// store twin matched nothing and the SAME physical message was counted once on
// each side. A workspace with 3 legacy lines and cursor 1 reported unread 4
// instead of 2, in the parent gate, in liveness, and in `inbox count` alike.
// The migration hashes each physical line as legacy:sha256(id\0index\0line)
// over the SAME non-empty-line filter this module applies, so recomputing it
// here reproduces the store row's hash exactly and the two sides collapse.
function legacyLineHash(id, index, line) {
  return 'legacy:' + crypto.createHash('sha256')
    .update(String(id) + '\x00' + String(index) + '\x00' + String(line))
    .digest('hex');
}

// hashesForLine(id, index, line) -> string[] — every hash under which this one
// physical NDJSON line could have been recorded on the store side: its embedded
// `_h` (native-drained rows) AND its legacy line hash (migrated rows). Both are
// contributed unconditionally; a line is only ever ONE of the two shapes, so the
// other simply never matches anything.
function hashesForLine(id, index, line) {
  const out = [];
  try {
    const o = JSON.parse(line);
    if (o && typeof o === 'object' && o._h != null) out.push(String(o._h));
  } catch (_) { /* unparsable line: no embedded hash, never thrown */ }
  if (id != null) out.push(legacyLineHash(id, index, line));
  return out;
}

// ndjsonHashesFromLines(lines) -> Set<string> of each parsed line's embedded
// `_h` content hash (devswarm-pull.js pullOnce writes `{_h, fromBranch,
// message, createdAt, status}` per NDJSON line). Verbatim copy of
// scripts/devswarm.js's own helper (kept here as the canonical copy; the CLI
// now delegates to this one).
// `id` + `startIndex` (both optional, ADDITIVE): when supplied, each line ALSO
// contributes its legacy line hash (see hashesForLine). Omitting them keeps the
// pre-fix `_h`-only behaviour byte-for-byte for any caller that has neither.
function ndjsonHashesFromLines(lines, id, startIndex) {
  const set = new Set();
  const base = Number.isFinite(startIndex) && startIndex > 0 ? Math.floor(startIndex) : 0;
  let i = 0;
  for (const line of lines) {
    for (const h of hashesForLine(id, base + i, line)) set.add(h);
    i++;
  }
  return set;
}

// ndjsonAllHashes(inboxPath, fsi) -> Set<string> of EVERY line's `_h` in the
// durable NDJSON (not just the unread tail) — used for the `total` union so
// an already-consumed native-drained message isn't double-counted against
// its store-side parity-fed twin. Fail-soft: absent/unreadable -> empty Set.
// `id` (optional, ADDITIVE): enables the legacy-line hash tier, exactly as in
// ndjsonHashesFromLines. The non-empty-line filter and the resulting index are
// the SAME ones countMessages/unreadBacklog/devswarm-migrate all apply, so the
// index a line hashes under here is the index it was migrated under.
function ndjsonAllHashes(inboxPath, fsi, id) {
  const F = fsi || fs;
  let raw;
  try { raw = String(F.readFileSync(inboxPath, 'utf8')); } catch (_) { return new Set(); }
  const set = new Set();
  let i = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    // The UNTRIMMED line is what devswarm-migrate.js's readInbox keeps (it
    // filters on `l.trim() !== ''` but stores `l`), and therefore what
    // legacyLineHash was computed over. Hashing the trimmed form here would
    // silently stop matching every line with trailing whitespace.
    for (const h of hashesForLine(id, i, line)) set.add(h);
    i++;
  }
  return set;
}

// rowTs(row) -> finite ms | null. Best-effort timestamp extraction shared by
// oldestUnreadAgeMs below — a store row already carries a numeric `ts`
// (devswarm-store.js listMessages); an NDJSON line may carry `ts` OR the
// native-pull shape's `createdAt` (devswarm-pull.js pullOnce). Never throws.
function rowTs(row) {
  if (!row || typeof row !== 'object') return null;
  if (Number.isFinite(row.ts)) return row.ts;
  if (Number.isFinite(row.createdAt)) return row.createdAt;
  return null;
}

// oldestUnreadAgeMs(ndjsonUnreadLines, storeOnlyUnreadRows, now) -> ms | null.
// The age (now - oldest ts) of the OLDEST still-unread row across BOTH the
// NDJSON unread tail (raw text lines, JSON-parsed defensively) and the
// store-only unread rows (already-parsed objects). null when no row carries
// a usable timestamp (fail-open: an unknown age never becomes a stall
// signal — see liveness.js's notDraining, which requires a KNOWN age).
function oldestUnreadAgeMs(ndjsonUnreadLines, storeOnlyUnreadRows, now) {
  const n = Number.isFinite(now) ? now : Date.now();
  let oldest = null;
  for (const line of (ndjsonUnreadLines || [])) {
    let ts = null;
    try {
      const o = JSON.parse(line);
      ts = rowTs(o);
    } catch (_) { ts = null; }
    if (Number.isFinite(ts) && (oldest === null || ts < oldest)) oldest = ts;
  }
  for (const row of (storeOnlyUnreadRows || [])) {
    const ts = rowTs(row);
    if (Number.isFinite(ts) && (oldest === null || ts < oldest)) oldest = ts;
  }
  if (oldest === null) return null;
  const age = n - oldest;
  return age >= 0 ? age : null; // a future ts is not evidence of anything (mirrors liveness.js's isFreshBeat posture)
}

// unionUnread({ inboxPath, cursorPath, id, storeHandle, fsi }) ->
//   { unread, total, cursor, storeCursor, known, ndjsonUnreadLines,
//     storeOnlyUnreadRows, oldestUnreadAgeMs }
//
// `storeHandle` is OPTIONAL and CALLER-OPENED (this function never opens or
// closes a store — see the header). When absent or when reading it throws,
// this degrades to NDJSON-only reporting (`storeOnlyUnreadRows: []`), so a
// caller unable to resolve a repoKey/open a store still gets a correct,
// non-throwing NDJSON-only count — never a hard failure.
function unionUnread(opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const u = readUnread(o.inboxPath, o.cursorPath, o.fsi);
  let storeCursorVal = 0;
  let storeOnlyUnreadRows = [];
  let storeOnlyTotalCount = 0;
  try {
    if (o.storeHandle && o.id != null) {
      const storeHandle = o.storeHandle;
      const id = o.id;
      storeCursorVal = storeHandle.cursorValue(id);
      // `id` is threaded into BOTH hash derivations so the legacy-line tier
      // (see hashesForLine) can fire; without it only `_h` is matched, which is
      // exactly the pre-fix double-count.
      const allNdjsonHashes = ndjsonAllHashes(o.inboxPath, o.fsi, id);
      // ABSOLUTE indices for the unread tail: legacyLineHash is index-sensitive
      // and `u.lines` is the tail slice, so its first line's real position is
      // (total - tail length), never 0. Deriving it from the two lengths (rather
      // than trusting the cursor) stays correct even for a cursor clamped or
      // written past the end.
      const unreadNdjsonHashes = ndjsonHashesFromLines(u.lines, id, Math.max(0, u.total - u.lines.length));
      const storeAllRows = storeHandle.listMessages(id);
      storeOnlyTotalCount = storeAllRows.filter((r) => !r.hash || !allNdjsonHashes.has(r.hash)).length;
      const storeUnreadRows = storeHandle.listMessages(id, { sinceCursor: storeCursorVal });
      storeOnlyUnreadRows = storeUnreadRows.filter((r) => !r.hash || !unreadNdjsonHashes.has(r.hash));
    }
  } catch (_) { /* fail-open: NDJSON-only reporting, matches pre-fix CLI behavior */ }

  const mergedTotal = u.total + storeOnlyTotalCount;
  const mergedUnreadCount = u.lines.length + storeOnlyUnreadRows.length;

  return {
    unread: mergedUnreadCount,
    total: mergedTotal,
    cursor: u.cursor,
    storeCursor: storeCursorVal,
    known: u.known,
    ndjsonUnreadLines: u.lines,
    storeOnlyUnreadRows,
    oldestUnreadAgeMs: oldestUnreadAgeMs(u.lines, storeOnlyUnreadRows, now),
  };
}

// openStoreForUnread(opts) -> store handle | null. Best-effort, LAZY +
// GUARDED (D27 idiom used throughout this codebase's hooks): resolves a
// repoKey from `worktreePath` (companion/lib/devswarm-repokey.js) and opens
// that project's store (companion/lib/devswarm-store.js). Returns null on
// ANY failure (missing/corrupt module, unresolvable repoKey, a store-open
// error) — callers must treat null as "fall back to NDJSON-only" and must
// NEVER let a null handle throw. This is a convenience for hot-path callers
// (hooks, liveness.js) that only need a quick, disposable read; a caller that
// needs the handle to outlive a mutation (the CLI's `inbox ack`) should keep
// resolving/opening its own handle instead.
function openStoreForUnread(opts) {
  const o = opts || {};
  try {
    const storeMod = require('./devswarm-store.js');
    // `opts.repoKey` lets a caller that already resolved this worktree's repoKey
    // (e.g. a loop over many descriptors that memoizes repoKeyForWorktree per
    // worktreePath) pass it straight through, skipping a second, redundant git
    // spawn for the SAME worktree this call — a real cost on a hot Stop-hook
    // path with a bounded time budget. Falls back to resolving it here (the
    // original, still-correct behavior) when the caller has not already done so.
    let repoKey = o.repoKey;
    if (repoKey === undefined) {
      const repokeyMod = require('./devswarm-repokey.js');
      repoKey = o.worktreePath ? repokeyMod.repoKeyForWorktree(o.worktreePath) : null;
    }
    if (!repoKey) return null;
    return storeMod.openStore({ home: o.home, workspaceId: o.id, hash: repoKey, env: o.env });
  } catch (_) {
    return null;
  }
}

module.exports = {
  legacyLineHash,
  hashesForLine,
  ndjsonHashesFromLines,
  ndjsonAllHashes,
  oldestUnreadAgeMs,
  unionUnread,
  openStoreForUnread,
};
