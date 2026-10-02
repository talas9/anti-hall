'use strict';
// anti-hall :: task-subject-backfill — recover the subject of an OPEN task whose
// TaskCreate sits BEFORE the capped transcript tail window.
//
// WHY: task-guard / task-tracker reconstruct task STATE from the last
// MAX_TAIL_BYTES (1.5MB) of the transcript. A task created earlier and only
// TaskUpdate'd inside the window has no subject there (content === id) and the
// Stop reason said `"(subject unknown)"`. State stays windowed; only the SUBJECT
// is looked up, and only when an open task lacks one, in one extra bounded pass.
//
// DESIGN
//  - Scans BACKWARD from the window start, so the first create found for an id is
//    its LATEST creation.
//  - PAIRING (no spoofing): a "Task #N created successfully" tool_result is only
//    a CANDIDATE (tool_use_id -> N), accepted only from a `user` record. It counts
//    once the assistant record holding a `tool_use` named TaskCreate with that SAME
//    id is read (backward, the result is met first). The subject comes from that
//    tool_use input (subject/title/content/description, as parseTasksFromFile);
//    the result text only supplies the numeric id. Unpaired candidates (e.g. a
//    Bash `cat` of a log) are dropped. Sidechain (isSidechain) records are ignored.
//  - EPOCH SAFETY (the harness restarts numbering at #1 after a list reset):
//    stop scanning (apply nothing older) at any reset marker ("No tasks found",
//    "Task not found", a TodoWrite) and whenever a create id is >= the next-newer
//    create id (numbering went backward => a reset lies between). Callers also
//    pass windowReset (a reset inside the window) => no backfill at all, and
//    firstCreated (first create id in the window): an unknown id >= it cannot have
//    been created before the window. Reset markers are matched by substring and
//    over-match on purpose: over-matching can only leave a subject unknown.
//  - CAPS: 64MB scanned (same far-back budget as lib/agent-scan.js), 150ms wall
//    clock, 1MB chunks (never the whole file in one string); injectable via meta
//    (maxBytes/maxMs/chunkBytes) for tests only. Any error/cap => nothing more is
//    applied => the caller's "(subject unknown)" stays. Never throws.
//
// Pure Node built-ins only.

const fs = require('fs');
const { MAX_TAIL_BYTES } = require('./transcript-tail.js');

const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_MS = 150;
const CHUNK = 1024 * 1024;
const MAX_SUBJECT = 200;
const MAX_CANDIDATES = 256;
const MARK = 'created successfully: ';
const RESET_MARKS = ['No tasks found', 'Task not found', '"TodoWrite"'];
const TERMINAL = /^(completed|done|cancelled|canceled)$/i;

// End (exclusive byte offset) of the line that straddles the window start: the
// readers drop that partial first line, so the backward scan must own it.
function prefixEndOf(fd, start, deadline) {
  const buf = Buffer.alloc(256 * 1024);
  let pos = start;
  for (let read = 0; read < 8 * 1024 * 1024 && Date.now() < deadline; read += buf.length) {
    const got = fs.readSync(fd, buf, 0, buf.length, pos);
    if (got <= 0) return -1;
    const i = buf.indexOf(10);
    if (i >= 0 && i < got) return pos + i + 1;
    pos += got;
  }
  return -1;
}

// A `user` record's "Task #N created successfully" tool_results -> [{id, n}].
function candidatesFromLine(line) {
  let entry;
  try { entry = JSON.parse(line); } catch (_) { return []; }
  if (!entry || entry.type !== 'user' || entry.isSidechain === true) return [];
  const c = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
  const out = [];
  for (const it of c) {
    if (!it || it.type !== 'tool_result' || typeof it.tool_use_id !== 'string') continue;
    let txt = it.content;
    if (Array.isArray(txt)) txt = txt.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
    if (typeof txt !== 'string') continue;
    const m = txt.match(/^Task\s+#(\d+)\s+created\s+successfully/i);
    if (m) out.push({ id: it.tool_use_id, n: Number(m[1]) });
  }
  return out;
}

// An `assistant` record's TaskCreate tool_use blocks -> [{id, subject}].
function createsFromLine(line) {
  let entry;
  try { entry = JSON.parse(line); } catch (_) { return []; }
  if (!entry || entry.type !== 'assistant' || entry.isSidechain === true) return [];
  const c = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
  const out = [];
  for (const it of c) {
    if (!it || it.type !== 'tool_use' || it.name !== 'TaskCreate' || typeof it.id !== 'string') continue;
    const inp = it.input || {};
    const s = inp.subject || inp.title || inp.content || inp.description;
    out.push({ id: it.id, subject: typeof s === 'string' ? s.trim().slice(0, MAX_SUBJECT) : '' });
  }
  return out;
}

// backfillSubjects(taskMap, transcriptPath, { windowReset, firstCreated })
// Mutates open, subject-less tasks of taskMap in place (task.content). Returns
// the number backfilled. Fast path: no open subject-less numeric task => no I/O.
function backfillSubjects(taskMap, transcriptPath, meta) {
  let fd = null;
  try {
    if (!taskMap || !transcriptPath || (meta && meta.windowReset)) return 0;
    const first = meta && Number.isFinite(meta.firstCreated) ? meta.firstCreated : Infinity;
    const wanted = new Map(); // numeric id -> task
    for (const t of taskMap.values()) {
      if (!t || !/^\d+$/.test(String(t.id)) || String(t.content) !== String(t.id)) continue;
      if (TERMINAL.test(String(t.status || ''))) continue;
      if (Number(t.id) >= first) continue; // its create must be inside the window (or a reset)
      wanted.set(Number(t.id), t);
    }
    if (wanted.size === 0) return 0;

    const maxBytes = meta && Number.isFinite(meta.maxBytes) ? meta.maxBytes : MAX_SCAN_BYTES;
    const maxMs = meta && Number.isFinite(meta.maxMs) ? meta.maxMs : MAX_SCAN_MS;
    const chunk = meta && Number.isFinite(meta.chunkBytes) && meta.chunkBytes > 0 ? meta.chunkBytes : CHUNK;
    const deadline = Date.now() + maxMs;
    const size = fs.statSync(transcriptPath).size;
    const start = size - MAX_TAIL_BYTES;
    if (start <= 0) return 0; // whole file was already read
    fd = fs.openSync(transcriptPath, 'r');
    let pos = prefixEndOf(fd, start, deadline);
    if (pos <= 0) return 0;

    let found = 0;
    let minCreated = first; // ids must strictly decrease going backward
    const cands = new Map(); // tool_use_id -> N, results awaiting their TaskCreate
    let carry = Buffer.alloc(0);
    let scanned = 0;
    while (pos > 0 && scanned < maxBytes && Date.now() < deadline && wanted.size > 0) {
      const n = Math.min(chunk, pos);
      const buf = Buffer.alloc(n);
      pos -= n;
      scanned += n;
      if (fs.readSync(fd, buf, 0, n, pos) !== n) return found;
      const comb = Buffer.concat([buf, carry]);
      let body = comb;
      if (pos > 0) {
        const i = comb.indexOf(10);
        if (i < 0) { carry = comb; continue; }
        carry = comb.subarray(0, i);
        body = comb.subarray(i + 1);
      }
      const lines = body.toString('utf8').split('\n');
      for (let k = lines.length - 1; k >= 0; k--) {
        const line = lines[k];
        if (line.indexOf(MARK) !== -1) {
          const cs = candidatesFromLine(line);
          if (cs.length) {
            for (const c of cs) {
              if (cands.size >= MAX_CANDIDATES) cands.delete(cands.keys().next().value);
              cands.set(c.id, c.n);
            }
            continue;
          }
        }
        if (cands.size > 0 && line.indexOf('"TaskCreate"') !== -1) {
          for (const cr of createsFromLine(line)) {
            if (!cands.has(cr.id)) continue;
            const num = cands.get(cr.id);
            cands.delete(cr.id);
            if (num >= minCreated) return found; // numbering restarted: reset between
            minCreated = num;
            const t = wanted.get(num);
            if (t && cr.subject) { t.content = cr.subject; wanted.delete(num); found++; }
            if (wanted.size === 0) return found;
          }
        }
        if (RESET_MARKS.some((m) => line.indexOf(m) !== -1)) return found;
      }
    }
    return found;
  } catch (_) {
    return 0;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* best-effort */ } }
  }
}

module.exports = { backfillSubjects, MAX_SCAN_BYTES, MAX_SCAN_MS };
