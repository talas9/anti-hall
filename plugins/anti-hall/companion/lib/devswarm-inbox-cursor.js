'use strict';
// anti-hall :: devswarm inbox cursor — the minimal inbox read/ack cursor-advance
// primitive (audit P1-A). It advances the SAME cursorPath consumed by
// companion/lib/liveness.js unreadBacklog(): the cursor is a count of consumed
// non-empty NDJSON inbox lines. This is the parent-gate's non-skip clear path and
// the substrate the Phase-2 CLI (`devswarm inbox read/ack`) wraps — a thin wrapper
// around the existing durable-inbox file contract, NOT a new store.
//
// Contract parity with unreadBacklog(inboxPath, cursorPath):
//   inbox   = append-only NDJSON, one message per line; blank lines ignored.
//   cursor  = a bare integer (or {line:<int>}) = number of consumed lines.
// A message counts iff its line is non-empty after trim() — the exact filter
// unreadBacklog() applies, so the two never disagree about how many lines exist.
//
// Reads are fail-safe (unreadable/absent inbox or cursor -> empty / 0, never
// throw). The cursor write is atomic (tmp + rename) so a crash mid-write can never
// leave a torn cursor; hard fs errors (mkdir/rename) propagate to the caller — a
// silently-swallowed ack that reports success while the cursor never moved would be
// the more dangerous failure (the gate would falsely believe it cleared).

const fs = require('fs');
const path = require('path');
const { unreadBacklog } = require('./liveness.js');

// countMessages(inboxPath, fsi) -> int (>=0). Number of non-empty inbox lines,
// using the SAME filter unreadBacklog() applies. Absent/unreadable inbox -> 0.
function countMessages(inboxPath, fsi) {
  const F = fsi || fs;
  try {
    return String(F.readFileSync(inboxPath, 'utf8'))
      .split('\n')
      .filter((l) => l.trim() !== '')
      .length;
  } catch (_) {
    return 0;
  }
}

// readCursor(cursorPath, fsi) -> int (>=0). Parses a bare integer OR {line:<int>}.
// Absent / unparseable / negative -> 0 (fresh cursor: nothing consumed yet).
function readCursor(cursorPath, fsi) {
  const F = fsi || fs;
  try {
    const raw = String(F.readFileSync(cursorPath, 'utf8')).trim();
    let c;
    if (/^\d+$/.test(raw)) c = parseInt(raw, 10);
    else c = Number(JSON.parse(raw).line);
    if (Number.isFinite(c) && c >= 0) return Math.floor(c);
  } catch (_) {}
  return 0;
}

// writeCursorAtomic(cursorPath, value, F) — atomic tmp + rename, mirroring
// liveness.js writeVerdict. Writes a bare integer (unreadBacklog parses it).
function writeCursorAtomic(cursorPath, value, F) {
  F.mkdirSync(path.dirname(cursorPath), { recursive: true });
  const tmp = cursorPath + '.tmp';
  F.writeFileSync(tmp, String(value));
  F.renameSync(tmp, cursorPath);
}

// readUnread(inboxPath, cursorPath, fsi) ->
//   { lines: string[], count, cursor, total, known }.
// The unread slice, delegated to unreadBacklog() so read semantics stay identical
// to the staleness detector. `known:false` (matching unreadBacklog) means the
// cursor was unreadable/unparseable — treat as "nothing conclusively pending".
function readUnread(inboxPath, cursorPath, fsi) {
  const backlog = unreadBacklog(inboxPath, cursorPath, fsi);
  return {
    lines: backlog.lines,
    count: backlog.lines.length,
    cursor: readCursor(cursorPath, fsi),
    total: countMessages(inboxPath, fsi),
    known: backlog.known,
  };
}

// ackTo(cursorPath, n, fsi, inboxPath?) -> int. Set the cursor to an absolute
// consumed-count `n`, clamped to [0, total]. Clamping to the current message total
// prevents an over-ack (n > total) from silently swallowing messages that arrive
// later (cursor stuck past the end). When inboxPath is omitted the upper clamp is
// skipped (raw absolute set) — advanceCursor always passes it. Returns the value
// actually written.
function ackTo(cursorPath, n, fsi, inboxPath) {
  const F = fsi || fs;
  let target = Number(n);
  if (!Number.isFinite(target) || target < 0) target = 0;
  target = Math.floor(target);
  if (inboxPath !== undefined) {
    const total = countMessages(inboxPath, F);
    if (target > total) target = total;
  }
  writeCursorAtomic(cursorPath, target, F);
  return target;
}

// advanceCursor(inboxPath, cursorPath, fsi) -> int. Mark every currently-present
// message read: set the cursor to the current non-empty line count. Returns the
// new cursor value. This is the gate's clear-path (ack-all).
function advanceCursor(inboxPath, cursorPath, fsi) {
  const total = countMessages(inboxPath, fsi);
  return ackTo(cursorPath, total, fsi, inboxPath);
}

module.exports = {
  countMessages,
  readCursor,
  readUnread,
  ackTo,
  advanceCursor,
};
