'use strict';
// anti-hall :: task-subject-backfill — recover the STATE (status, owner,
// blockedBy, metadata.blockedOn) and the subject of an open-or-unknown task whose
// TaskCreate / earlier TaskUpdates sit BEFORE the capped transcript tail window.
//
// WHY: task-guard / task-tracker reconstruct task STATE from the last
// MAX_TAIL_BYTES (1.5MB) of the transcript. A task created earlier and only
// TaskUpdate'd inside the window (e.g. a description-only update) carries no
// subject, status or blockedOn there. The window parsers no longer GUESS those
// (an unseen id keeps status undefined = unknown plus `unknown` flags, see
// lib/task-state.js unseenTask); this one extra bounded pass recovers the LATEST
// value of each missing field from before the window, only when at least one task
// has an unknown field or no subject. No cache: it is a bounded scan that already
// fits well inside the cap.
//
// DESIGN
//  - Scans BACKWARD from the window start, so the first value found for a field is
//    its LATEST. Per field, a TaskUpdate input that carries the field wins over
//    older records; the TaskCreate is the origin (status pending, its owner /
//    blockedBy / blockedOn / subject) and ends the search for that id.
//    blockedOn follows the in-window parser: an update that omits it does NOT clear
//    an earlier value; one that sets metadata.blockedOn null explicitly does.
//    blockedBy: a replacement ends the search; addBlockedBy deltas accumulate.
//  - A status carried INSIDE the window is the truth for status: the pass then only
//    fills the OTHER fields, and a terminal status from before the window neither
//    stops the scan nor closes the task (completed before, re-opened inside).
//  - PAIRING (no spoofing): a "Task #N created successfully" tool_result is only
//    a CANDIDATE (tool_use_id -> N), accepted only from a `user` record. It counts
//    once the assistant record holding a `tool_use` named TaskCreate with that SAME
//    id is read. Unpaired candidates (e.g. a Bash `cat` of a log) are dropped.
//    TaskUpdate inputs name their id directly. Sidechain records are ignored.
//  - RESET vs NOT-FOUND. The epoch boundary (stop: nothing older is applied) is a
//    REAL list reset: numbering restarting (a TaskCreate result whose id is <= the
//    next-newer one, creates of ONE assistant message never count: parallel calls
//    may be numbered in reverse), a `user` tool_result starting "No tasks found"
//    that pairs with a TaskList tool_use, or an assistant TodoWrite tool_use.
//    "Task not found" (a TaskGet/TaskUpdate result paired with its tool_use) is
//    PER ID: that id does not exist (closed), the failed update is not applied, the
//    scan goes on for every other id. Lines that merely QUOTE these phrases are not
//    markers: the substring tests are only a cheap pre-filter, the JSON line is
//    parsed.
//  - Callers pass windowReset (a real reset inside the window => no recovery) and
//    firstCreated (an id >= it cannot have been created before the window).
//  - RULE FOR WHAT STAYS UNKNOWN (applied after the scan):
//      status       never found (and none in the window)  -> undefined (unknown):
//                   left out of the Stop block and counted in the unknown note
//      owner/blockedBy/blockedOn  not found
//                   - the scan reached the task's create -> defaults (unowned, no
//                     blockers, not blocked): the create proves they were never set
//                   - it did NOT (cap / reset / error / end of file without the
//                     create) -> `blockUnknown` is set. A task with a KNOWN open
//                     status (from the window or recovered) is NEVER dropped from
//                     the generic open-tasks Stop block; it is only excluded from the
//                     idle-neglect "dispatch now" set (it may be waiting on the
//                     owner) and counted in the note (lib/task-state.js).
//      completed/deleted before the window (and nothing newer in it) stays closed.
//  - CAPS: 64MB scanned (same far-back budget as lib/agent-scan.js), 150ms wall
//    clock, 1MB chunks (never the whole file in one string); injectable via meta
//    (maxBytes/maxMs/chunkBytes/windowBytes) for tests only. Never throws.
//
// Pure Node built-ins only.

const fs = require('fs');
const { MAX_TAIL_BYTES } = require('./transcript-tail.js');
const DD = require('./dispatch-demand.js');

const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_MS = 150;
const CHUNK = 1024 * 1024;
const MAX_SUBJECT = 200;
const MAX_CANDIDATES = 256;
const TERMINAL = /^(completed|done|cancelled|canceled|deleted)$/i;
const FIELDS = ['status', 'owner', 'blockedBy', 'blockedOn'];

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

function textOf(c) {
  if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  return typeof c === 'string' ? c : '';
}
function norm(b) {
  if (Array.isArray(b)) return b.filter((x) => x != null).map(String);
  return b != null && (typeof b === 'string' || typeof b === 'number') ? [String(b)] : [];
}
function idOf(inp) {
  const v = inp.taskId != null ? inp.taskId : inp.id != null ? inp.id : inp.task_id;
  return v != null ? String(v) : null;
}
function subjectOf(inp) {
  const s = inp.subject || inp.title || inp.content || inp.description;
  return typeof s === 'string' ? s.trim().slice(0, MAX_SUBJECT) : '';
}
function blockedOnOf(inp) {
  return (inp.metadata != null && inp.metadata.blockedOn != null) ? inp.metadata.blockedOn : inp.blockedOn;
}

// One parsed transcript line -> { msgId, cands, resets, calls, creates, updates, todo }.
// Every field is empty for sidechain / unparsable / irrelevant lines. msgId is the
// assistant message id (parallel tool_use blocks of ONE message share it).
function classify(line) {
  const r = { msgId: null, cands: [], resets: [], calls: [], creates: [], updates: [], todo: false };
  let entry;
  try { entry = JSON.parse(line); } catch (_) { return r; }
  if (!entry || entry.isSidechain === true) return r;
  if (entry.message && typeof entry.message.id === 'string') r.msgId = entry.message.id;
  const c = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
  for (const it of c) {
    if (!it) continue;
    if (entry.type === 'user' && it.type === 'tool_result' && typeof it.tool_use_id === 'string') {
      const txt = textOf(it.content);
      const m = txt.match(/^Task\s+#(\d+)\s+created\s+successfully/i);
      if (m) r.cands.push({ id: it.tool_use_id, n: Number(m[1]) });
      else if (DD.isTaskListEmptyText(txt)) r.resets.push({ id: it.tool_use_id, tools: ['TaskList'] });
      else if (DD.isTaskNotFoundText(txt)) r.resets.push({ id: it.tool_use_id, tools: ['TaskGet', 'TaskUpdate'] });
    } else if (entry.type === 'assistant' && it.type === 'tool_use') {
      const inp = it.input || {};
      if (typeof it.id === 'string') r.calls.push({ id: it.id, name: it.name, taskId: idOf(inp) });
      if (it.name === 'TodoWrite') r.todo = true;
      else if (it.name === 'TaskCreate' && typeof it.id === 'string') r.creates.push({ id: it.id, inp });
      else if (it.name === 'TaskUpdate') { const id = idOf(inp); if (id != null) r.updates.push({ id, inp, tid: it.id }); }
    }
  }
  return r;
}

// ---- per-id recovered record ----
// f.<field> = that field was found; st/own/bo/subject = its value; bb = blockedBy
// base (replacement or create), adds = addBlockedBy deltas newer than it;
// cr = the task's TaskCreate was reached; ab = id reported "Task not found";
// done = nothing older can change this record. needStatus = the window did not
// carry a status, so an older terminal status may close the task.
function newRec(needStatus) {
  return { needStatus, f: { status: false, owner: false, blockedBy: false, blockedOn: false, subject: false }, st: null, own: '', bo: undefined, bb: [], adds: [], subject: '', cr: false, ab: false, done: false };
}
function recUpdate(rec, inp) {
  if (!rec.f.status && inp.status) {
    rec.f.status = true; rec.st = inp.status;
    if (rec.needStatus && TERMINAL.test(String(inp.status))) rec.done = true;
  }
  if (!rec.f.owner && inp.owner !== undefined) { rec.f.owner = true; rec.own = typeof inp.owner === 'string' ? inp.owner.trim() : ''; }
  if (!rec.f.blockedOn && (inp.blockedOn !== undefined || (inp.metadata != null && inp.metadata.blockedOn !== undefined))) {
    rec.f.blockedOn = true; rec.bo = blockedOnOf(inp);
  }
  if (!rec.f.blockedBy) {
    if (inp.blockedBy !== undefined) {
      rec.f.blockedBy = true;
      rec.bb = [...norm(inp.blockedBy), ...(inp.addBlockedBy !== undefined ? norm(inp.addBlockedBy) : [])];
    } else if (inp.addBlockedBy !== undefined) {
      for (const x of norm(inp.addBlockedBy)) if (!rec.adds.includes(x)) rec.adds.push(x);
    }
  }
  if (!rec.f.subject && typeof inp.subject === 'string' && inp.subject.trim()) { rec.f.subject = true; rec.subject = inp.subject.trim().slice(0, MAX_SUBJECT); }
}
function recCreate(rec, inp) {
  if (!rec.f.status) { rec.f.status = true; rec.st = inp.status || 'pending'; }
  if (!rec.f.owner) { rec.f.owner = true; rec.own = typeof inp.owner === 'string' ? inp.owner.trim() : ''; }
  if (!rec.f.blockedOn) { rec.f.blockedOn = true; rec.bo = blockedOnOf(inp); }
  if (!rec.f.blockedBy) { rec.f.blockedBy = true; rec.bb = norm(inp.blockedBy); }
  const s = subjectOf(inp);
  if (!rec.f.subject && s) { rec.f.subject = true; rec.subject = s; }
  rec.cr = true; rec.done = true;
}

// Apply a recovered record to a task (only the fields the task is missing).
function applyRec(w, rec, touched) {
  const t = w.task;
  const need = w.need;
  if (rec.ab) {
    // The harness said this id does not exist: closed, not open, not unknown.
    if (need.status && !rec.f.status) { t.status = 'deleted'; touched.add(t); }
    return;
  }
  if (need.status) {
    if (rec.f.status) { t.status = rec.st; touched.add(t); } else t.status = undefined;
  }
  if (TERMINAL.test(String(t.status || ''))) return;
  let unresolved = false;
  const dflt = rec.cr; // the create was reached => an absent field was never set
  if (need.owner) { if (rec.f.owner) t.owner = rec.own; else if (dflt) t.owner = ''; else unresolved = true; }
  if (need.blockedOn) { if (rec.f.blockedOn) t.blockedOn = rec.bo; else if (dflt) t.blockedOn = undefined; else unresolved = true; }
  if (need.blockedBy) {
    if (rec.f.blockedBy) t.blockedBy = [...new Set([...rec.bb, ...rec.adds, ...(t.blockedBy || [])])];
    else if (dflt) t.blockedBy = [...new Set([...rec.adds, ...(t.blockedBy || [])])];
    else unresolved = true;
  }
  if (need.subject && rec.f.subject) { t.content = rec.subject; touched.add(t); }
  if (unresolved) t.blockUnknown = true;
}

// backfillSubjects(taskMap, transcriptPath, { windowReset, firstCreated, windowBytes })
// Mutates open-or-unknown tasks of taskMap in place. Returns the number of tasks
// that gained any recovered value. Fast path: no wanted task => no I/O.
function backfillSubjects(taskMap, transcriptPath, meta) {
  let fd = null;
  const wanted = new Map(); // numeric id -> { task, need:{subject,status,owner,blockedBy,blockedOn} }
  const recs = new Map(); // numeric id -> rec
  const touched = new Set();
  let attempted = false;
  try {
    if (!taskMap || !transcriptPath || (meta && meta.windowReset)) return 0;
    const first = meta && Number.isFinite(meta.firstCreated) ? meta.firstCreated : Infinity;
    for (const t of taskMap.values()) {
      if (!t || !/^\d+$/.test(String(t.id))) continue;
      if (TERMINAL.test(String(t.status || ''))) continue;
      if (Number(t.id) >= first) continue; // its create must be inside the window (or a reset)
      const need = { subject: String(t.content) === String(t.id) };
      let any = need.subject;
      for (const f of FIELDS) { need[f] = !!(t.unknown && t.unknown[f]); any = any || need[f]; }
      if (any) wanted.set(Number(t.id), { task: t, need });
    }
    if (wanted.size === 0) return 0;

    const maxBytes = meta && Number.isFinite(meta.maxBytes) ? meta.maxBytes : MAX_SCAN_BYTES;
    const maxMs = meta && Number.isFinite(meta.maxMs) ? meta.maxMs : MAX_SCAN_MS;
    const chunk = meta && Number.isFinite(meta.chunkBytes) && meta.chunkBytes > 0 ? meta.chunkBytes : CHUNK;
    const winBytes = meta && Number.isFinite(meta.windowBytes) && meta.windowBytes > 0 ? meta.windowBytes : MAX_TAIL_BYTES;
    const deadline = Date.now() + maxMs;
    const size = fs.statSync(transcriptPath).size;
    const start = size - winBytes;
    if (start <= 0) { wanted.clear(); return 0; } // whole file was already read
    attempted = true;
    for (const [n, w] of wanted) recs.set(n, newRec(w.need.status));

    fd = fs.openSync(transcriptPath, 'r');
    let pos = prefixEndOf(fd, start, deadline);
    if (pos <= 0) return 0;

    let minCreated = first; // ids must strictly decrease going backward (across messages)
    let groupId = null; // assistant message id of the create group being scanned
    let groupBase = first; // minCreated BEFORE that group started
    const cands = new Map(); // tool_use_id -> N, results awaiting their TaskCreate
    const resetCands = new Map(); // tool_use_id -> accepted tool names, awaiting their tool_use
    const failed = new Set(); // tool_use_ids of TaskUpdate calls that returned "Task not found"
    const trim = (m) => { if (m.size >= MAX_CANDIDATES) m.delete(m.keys().next().value); };
    const pendingCount = () => { let n = 0; for (const r of recs.values()) if (!r.done) n++; return n; };
    let carry = Buffer.alloc(0);
    let scanned = 0;
    let stopped = false;
    while (pos > 0 && scanned < maxBytes && !stopped) {
      if (Date.now() >= deadline) break;
      if (pendingCount() === 0) break;
      const n = Math.min(chunk, pos);
      const buf = Buffer.alloc(n);
      pos -= n;
      scanned += n;
      if (fs.readSync(fd, buf, 0, n, pos) !== n) break;
      const comb = Buffer.concat([buf, carry]);
      let body = comb;
      if (pos > 0) {
        const i = comb.indexOf(10);
        if (i < 0) { carry = comb; continue; }
        carry = comb.subarray(0, i);
        body = comb.subarray(i + 1);
      }
      const lines = body.toString('utf8').split('\n');
      for (let k = lines.length - 1; k >= 0 && !stopped; k--) {
        const line = lines[k];
        // Cheap pre-filter only; the JSON line is parsed before anything counts.
        if (line.indexOf('Task') === -1 && line.indexOf('TodoWrite') === -1 && line.indexOf('No tasks found') === -1) continue;
        const r = classify(line);
        for (const c of r.cands) { trim(cands); cands.set(c.id, c.n); }
        for (const x of r.resets) { trim(resetCands); resetCands.set(x.id, x.tools); }
        if (r.todo) { stopped = true; break; }
        for (const call of r.calls) {
          const tools = resetCands.get(call.id);
          if (!tools || tools.indexOf(call.name) === -1) continue;
          if (call.name === 'TaskList') { stopped = true; break; } // real reset: store empty
          // TaskGet / TaskUpdate "Task not found": per id, never an epoch boundary.
          failed.add(call.id);
          const rec = call.taskId != null && /^\d+$/.test(call.taskId) ? recs.get(Number(call.taskId)) : null;
          if (rec && !rec.done) { rec.ab = !rec.f.status; rec.done = true; }
        }
        if (stopped) break;
        for (const u of r.updates) {
          if (failed.has(u.tid)) continue; // a failed update changed nothing
          const rec = /^\d+$/.test(u.id) ? recs.get(Number(u.id)) : null;
          if (rec && !rec.done) recUpdate(rec, u.inp);
        }
        // Creates of ONE assistant message (parallel calls, possibly numbered in
        // reverse; same line or same message id) are compared with the state BEFORE
        // that message, never with each other.
        if (r.creates.length > 0 && !(r.msgId && r.msgId === groupId)) { groupId = r.msgId; groupBase = minCreated; }
        for (const cr of r.creates) {
          if (!cands.has(cr.id)) continue;
          const num = cands.get(cr.id);
          cands.delete(cr.id);
          if (num >= groupBase) { stopped = true; break; } // numbering restarted: reset between
          minCreated = Math.min(minCreated, num);
          const rec = recs.get(num);
          if (rec && !rec.done) recCreate(rec, cr.inp);
        }
      }
    }
    return 0;
  } catch (_) {
    return 0;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* best-effort */ } }
    if (attempted) {
      // Apply what was recovered (nothing recovered => unknown).
      try { for (const [n, w] of wanted) applyRec(w, recs.get(n) || newRec(w.need.status), touched); } catch (_) { /* fail-open */ }
    }
    // eslint-disable-next-line no-unsafe-finally -- the count is only known after applying
    return touched.size;
  }
}

module.exports = { backfillSubjects, MAX_SCAN_BYTES, MAX_SCAN_MS };
