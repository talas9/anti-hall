// anti-hall :: transcript-tail — ONE capped tail read of a transcript/rollout
// file, shared by every consumer that needs to scan recent entries (usage,
// task state, ...) instead of each one re-reading the file independently.
//
// WHY: hooks/lib/context-pct.js and hooks/auto-handover-pause-nag.js's
// hasOpenTasks() both used to scan the SAME transcript tail independently,
// each with its own 256KB + (on miss) 4MB widen — up to ~8.5MB of synchronous
// reads on a single Stop invocation. This file reads ONCE, capped at
// MAX_TAIL_BYTES, and callers share the resulting lines.
//
// CAP TRADE-OFF: a single fixed cap (no widen-to-4MB retry) bounds worst-case
// I/O per hook call, at the cost of occasionally missing a usage/task entry
// that landed further back than MAX_TAIL_BYTES in an unusually chatty turn
// (large tool outputs). Both consumers are advisory (a nag or a soft
// estimate), not a hard gate, so an occasional miss degrades gracefully
// (context-pct.js falls through to "no usage found"; hasOpenTasks() returns
// "unknown", which pause-nag.js already treats as safe-to-nag).
//
// Pure Node built-ins only.

'use strict';

const fs = require('fs');

const MAX_TAIL_BYTES = 1.5 * 1024 * 1024; // 1.5MB — down from a worst-case ~8.5MB across two independent widened reads

// readTail(transcriptPath, maxBytes) -> string[] | null. Reads the last
// `maxBytes` (default MAX_TAIL_BYTES) of the file, splits into lines, and
// drops a possibly-partial first line when the file is larger than the
// requested tail. null on any missing/unreadable/empty file.
function readTail(transcriptPath, maxBytes) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  const bytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_TAIL_BYTES;
  let fd = null;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= 0) return null;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fd = fs.openSync(transcriptPath, 'r');
    const got = fs.readSync(fd, buf, 0, n, size - n);
    let lines = buf.toString('utf8', 0, got).split('\n');
    if (size > n) lines = lines.slice(1); // first line may be partial
    return lines;
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* best-effort */ } }
  }
}

module.exports = { readTail, MAX_TAIL_BYTES };
