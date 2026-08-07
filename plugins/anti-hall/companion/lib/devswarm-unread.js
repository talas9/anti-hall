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
const { readUnread } = require('./devswarm-inbox-cursor.js');

// ndjsonHashesFromLines(lines) -> Set<string> of each parsed line's embedded
// `_h` content hash (devswarm-pull.js pullOnce writes `{_h, fromBranch,
// message, createdAt, status}` per NDJSON line). Verbatim copy of
// scripts/devswarm.js's own helper (kept here as the canonical copy; the CLI
// now delegates to this one).
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

// ndjsonAllHashes(inboxPath, fsi) -> Set<string> of EVERY line's `_h` in the
// durable NDJSON (not just the unread tail) — used for the `total` union so
// an already-consumed native-drained message isn't double-counted against
// its store-side parity-fed twin. Fail-soft: absent/unreadable -> empty Set.
function ndjsonAllHashes(inboxPath, fsi) {
  const F = fsi || fs;
  let raw;
  try { raw = String(F.readFileSync(inboxPath, 'utf8')); } catch (_) { return new Set(); }
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
      const allNdjsonHashes = ndjsonAllHashes(o.inboxPath, o.fsi);
      const unreadNdjsonHashes = ndjsonHashesFromLines(u.lines);
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
  ndjsonHashesFromLines,
  ndjsonAllHashes,
  oldestUnreadAgeMs,
  unionUnread,
  openStoreForUnread,
};
