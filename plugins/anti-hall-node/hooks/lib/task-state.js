'use strict';
// anti-hall :: task-state — task-list reconstruction from a transcript tail
// (TodoWrite / TaskCreate + "Task #N created" result / TaskUpdate), shared by
// task-tracker (per-turn DISPATCH NOW line) and dispatch-tier (Jev tier
// recommendation). Moved verbatim from task-tracker.js; description + subject
// updates are tracked so a task's full text is known.

const DD = require('./dispatch-demand.js');

// Mode-agnostic task reconstruction (mirrors task-guard / tasklist-guard) → the
// set of OPEN tasks (pending | in_progress) PLUS the full taskMap (so blocker
// resolution can see completed tasks). Each task carries owner + blockedBy so the
// ACTIONABLE-NOW classification below matches task-guard exactly. Tolerant +
// best-effort; a status-only TaskUpdate must NOT clear owner/blockedBy.
function reconstructTasks(tail) {
  const lines = tail.data.split(/\r?\n/);
  if (tail.truncated && lines.length > 0) lines.shift();
  const provisional = new Map();
  const taskMap = new Map();
  const resultIds = new Map();
  let maxCreated = 0;
  let groupMsg = null; // assistant message id of the TaskCreate group being resolved
  let groupBase = 0;   // highest created id BEFORE that message
  // For lib/task-subject-backfill.js: a reset inside the window, first create id.
  let windowReset = false;
  let firstCreated = Infinity;
  // toolCallInfo: tool_use_id -> { name, taskId }, built from the assistant
  // tool_use entries (which precede their tool_result in transcript order).
  // Mirror task-guard.js: text content alone never proves WHICH tool
  // produced a "No tasks found"/"Task not found" result (a Bash line, or a
  // mistyped TaskGet id, must not wipe the whole map).
  const toolCallInfo = new Map();
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // Cheap pre-filter: only task-tool lines (and their "Task #N created"
    // results) matter here.
    if (t.indexOf('Task') === -1 && t.indexOf('TodoWrite') === -1) continue;
    let entry;
    try { entry = JSON.parse(t); } catch (_) { continue; }
    if (entry.type === 'user') {
      const c = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
      for (const it of c) {
        if (it && it.type === 'tool_result' && typeof it.tool_use_id === 'string') {
          const txt = typeof it.content === 'string' ? it.content : '';
          // TASK-LIST EPOCH — mirror task-guard.js: "No tasks found" FROM a
          // TaskList call (the store is empty NOW) is direct proof the
          // harness's task store no longer matches this reconstruction. A
          // "Task not found" FROM TaskGet/TaskUpdate only proves that ONE id
          // is stale — drop only that id, never the whole map.
          const call = toolCallInfo.get(it.tool_use_id);
          const callName = call ? call.name : '';
          if (callName === 'TaskList' && DD.isTaskListEmptyText(txt)) {
            taskMap.clear();
            provisional.clear();
            resultIds.clear();
            maxCreated = 0;
            windowReset = true;
          } else if ((callName === 'TaskGet' || callName === 'TaskUpdate') && DD.isTaskNotFoundText(txt)) {
            const badId = call && call.taskId != null ? String(call.taskId) : null;
            if (badId != null) {
              // Per id ONLY: "Task not found" says that id does not exist, NOT that
              // the list was reset (a mistyped id must not silence every other
              // task). The epoch boundary is the numbering restart (below), a
              // TaskList "No tasks found", or a TodoWrite.
              taskMap.delete(badId);
              for (const [tid, nid] of [...resultIds]) {
                if (nid === badId) { resultIds.delete(tid); provisional.delete(tid); }
              }
            }
          }
          const m = callName === 'TaskCreate' ? txt.match(/^Task\s+#(\d+)\s+created\s+successfully/i) : null;
          if (m && !resultIds.has(it.tool_use_id)) {
            // TASK-LIST EPOCH: the harness restarts numbering at #1 when its
            // list resets (restart/resume). A created id <= the highest one
            // already seen means the older tasks are gone — drop them so a
            // stale pre-reset "#50 in_progress" (or a reused #13) never
            // shadows the live list. Mirror task-guard.
            const n = Number(m[1]);
            // Creates of ONE assistant message (parallel calls may be numbered in
            // reverse) are compared with the state BEFORE that message, never each
            // other: a lower id inside the same message is not a restart.
            const mid = call && call.msgId;
            if (!(mid && mid === groupMsg)) { groupMsg = mid || null; groupBase = Math.max(maxCreated, DD.maxNumericKey(taskMap)); }
            if (n <= groupBase) {
              taskMap.clear();
              for (const tid of [...provisional.keys()]) if (resultIds.has(tid)) provisional.delete(tid);
              resultIds.clear();
              windowReset = true;
              maxCreated = 0;
              groupBase = 0;
            }
            firstCreated = Math.min(firstCreated, n);
            maxCreated = Math.max(maxCreated, n);
            resultIds.set(it.tool_use_id, m[1]);
          }
        }
      }
    }
    for (const tu of collectTU(entry)) {
      const name = tu.name || '';
      if (tu.id) {
        const inp0 = tu.input || {};
        const taskId = inp0.taskId != null ? inp0.taskId
                     : inp0.id != null ? inp0.id
                     : inp0.task_id != null ? inp0.task_id
                     : null;
        toolCallInfo.set(tu.id, { name, taskId, msgId: entry.message && typeof entry.message.id === 'string' ? entry.message.id : null });
      }
      if (name === 'TodoWrite') {
        const todos = tu.input && tu.input.todos;
        if (Array.isArray(todos)) {
          windowReset = true;
          taskMap.clear(); provisional.clear();
          for (const todo of todos) {
            const id = todo.id || todo.content || String(taskMap.size);
            taskMap.set(String(id), {
              id: String(id),
              content: todo.content || todo.activeForm || String(id),
              status: todo.status || 'pending',
              owner: normOwner(todo.owner),
              blockedBy: normBlockedBy(todo.blockedBy),
            });
          }
        }
      } else if (name === 'TaskCreate') {
        const inp = tu.input || {};
        const tid = tu.id || '';
        if (tid) provisional.set(tid, {
          content: inp.subject || inp.title || inp.content || inp.description || tid,
          description: typeof inp.description === 'string' ? inp.description : '',
          status: inp.status || 'pending',
          owner: normOwner(inp.owner),
          blockedBy: normBlockedBy(inp.blockedBy),
          blockedOn: (inp.metadata != null && inp.metadata.blockedOn != null) ? inp.metadata.blockedOn : inp.blockedOn,
        });
      } else if (name === 'TaskUpdate') {
        const inp = tu.input || {};
        const id = inp.taskId != null ? String(inp.taskId) : inp.id != null ? String(inp.id) : inp.task_id != null ? String(inp.task_id) : null;
        if (id != null) {
          const ex = taskMap.get(id) || unseenTask(id);
          taskMap.set(id, {
            id: ex.id,
            unknown: gapsAfterUpdate(ex.unknown, inp),
            // A TaskUpdate may rename the task or rewrite its description.
            content: typeof inp.subject === 'string' && inp.subject ? inp.subject : ex.content,
            description: typeof inp.description === 'string' ? inp.description : (ex.description || ''),
            subjectUpdated: (typeof inp.subject === 'string' && inp.subject) ? true : ex.subjectUpdated,
            // NEVER guess: an id first seen here keeps status undefined (unknown)
            // unless the update carries one (recovered from before the window by
            // lib/task-subject-backfill.js, else it stays unknown and un-nagged).
            status: inp.status || ex.status,
            // Only overwrite owner/blockedBy when the update carries the field; a
            // status-only update must not clear them (mirror task-guard).
            owner: inp.owner !== undefined ? normOwner(inp.owner) : (ex.owner || ''),
            // blockedBy replacement OR the harness's incremental addBlockedBy.
            blockedBy: DD.blockedByAfterUpdate(ex.blockedBy, inp, normBlockedBy),
            blockedOn: (inp.blockedOn !== undefined || (inp.metadata != null && inp.metadata.blockedOn !== undefined))
              ? ((inp.metadata != null && inp.metadata.blockedOn != null) ? inp.metadata.blockedOn : inp.blockedOn)
              : ex.blockedOn,
          });
        }
      }
    }
  }
  for (const [tid, rec] of provisional) {
    const key = String(resultIds.get(tid) || tid);
    let ex = taskMap.get(key);
    if (ex && ex.unknown) { ex = Object.assign({}, ex, fillFromCreate(ex, rec)); taskMap.set(key, ex); }
    if (!ex) taskMap.set(key, { id: key, content: rec.content, description: rec.description || '', status: rec.status, owner: rec.owner || '', blockedBy: rec.blockedBy || [], blockedOn: rec.blockedOn });
    else if (!ex.subjectUpdated || !ex.description) taskMap.set(key, {
      id: key,
      content: ex.subjectUpdated ? ex.content : rec.content,
      description: ex.description || rec.description || '',
      status: ex.status,
      owner: ex.owner || rec.owner || '',
      blockedBy: (ex.blockedBy && ex.blockedBy.length) ? ex.blockedBy : (rec.blockedBy || []),
      blockedOn: ex.blockedOn !== undefined ? ex.blockedOn : rec.blockedOn,
    });
  }
  // NOTE: callers that run the backfill AFTER this must recompute with openOf().
  return { open: openOf(taskMap), taskMap, windowReset, firstCreated };
}

// ---- the ONE open / unknown view of a task map (every consumer uses these) ----
// A task is OPEN when its status is KNOWN pending / in_progress: it stays in the
// generic open-tasks Stop block exactly as before, however much else is unknown.
// A task whose STATUS is undefined is UNKNOWN (never guessed) and is left out. A
// known-open task whose block state (owner / blockedBy / blockedOn) could not be
// established (`blockUnknown`, set by the backfill when the scan stopped before the
// task's create) may be legitimately waiting on the owner, so it is excluded ONLY
// from the idle-neglect / DISPATCH NOW set (isIdleCandidate) and counted in the
// unknown note.
function isOpenTask(t) {
  const s = ((t && t.status) || '').toLowerCase();
  return s === 'pending' || s === 'in_progress' || s === 'in-progress';
}
function isIdleCandidate(t) { return !t.blockUnknown; }
function openOf(taskMap) {
  const out = [];
  for (const t of taskMap.values()) if (isOpenTask(t)) out.push(t);
  return out;
}
function unknownOf(taskMap) {
  const out = [];
  for (const t of taskMap.values()) {
    if (!t.status) out.push(t);
    else if (isOpenTask(t) && t.blockUnknown) out.push(t);
  }
  return out;
}

// unknownNote(taskMap, { sessionId, tag }) -> ONE short advisory line, or ''.
// Throttled like the other advisories: printed only when the SET of unknown ids
// changed since it was last printed for this (session, tag), and at most
// MAX_UNKNOWN_NOTES times per session. State: ~/.anti-hall/last-unknown-<tag>-<session>.json,
// pruned by lib/state-prune.js (prefix "last-unknown").
// Never blocks; any error -> ''.
const MAX_UNKNOWN_NOTES = 3;
function unknownNote(taskMap, opts) {
  try {
    const unk = unknownOf(taskMap);
    if (unk.length === 0) return '';
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');
    const home = require('../../companion/lib/test-home-guard.js').resolveHome();
    const hash = crypto.createHash('sha1').update(unk.map((t) => String(t.id)).sort().join('\x00')).digest('hex');
    const sid = String((opts && opts.sessionId) || 'nosession').replace(/[^A-Za-z0-9_.-]/g, '_');
    const dir = path.join(home, '.anti-hall');
    const file = path.join(dir, 'last-unknown-' + String((opts && opts.tag) || 'x') + '-' + sid + '.json');
    let last = { hash: '', n: 0 };
    try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); if (p && typeof p === 'object') last = { hash: String(p.hash || ''), n: Number(p.n) || 0 }; } catch (_) { /* first time */ }
    if (last.hash === hash || last.n >= MAX_UNKNOWN_NOTES) return '';
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ hash, n: last.n + 1 }), 'utf8'); } catch (_) { return ''; }
    // One file per session, never read back by another session: sweep stale ones
    // (7-day TTL, throttled, own file kept) like the other per-session state files.
    try { require('./state-prune.js').pruneStale({ stateDir: dir, prefix: 'last-unknown', keepFile: file }); } catch (_) { /* best-effort */ }
    return unk.length + ' task(s) in an unknown state (their records are too far back to read) — re-state each with TaskUpdate (status) to refresh.';
  } catch (_) { return ''; }
}

// ---- unknown-field tracking (shared with task-guard + task-subject-backfill) ----
// A TaskUpdate for an id NOT seen in the window carries only what it carries; the
// rest (status/owner/blockedBy/blockedOn) lives before the window. Such a task is
// built by unseenTask(): status undefined (= UNKNOWN, never defaulted to pending)
// and `unknown` flags naming every field still to recover. gapsAfterUpdate clears
// a flag when an update explicitly carries the field; fillFromCreate resolves the
// remaining flags from an in-window TaskCreate (the origin of the task).
function unseenTask(id) {
  return {
    id, content: id, status: undefined, owner: '', blockedBy: [], blockedOn: undefined,
    unknown: { status: true, owner: true, blockedBy: true, blockedOn: true },
  };
}

function gapsAfterUpdate(unknown, inp) {
  if (!unknown) return undefined;
  const u = Object.assign({}, unknown);
  if (inp.status) u.status = false;
  if (inp.owner !== undefined) u.owner = false;
  if (inp.blockedBy !== undefined) u.blockedBy = false;
  if (inp.blockedOn !== undefined || (inp.metadata != null && inp.metadata.blockedOn !== undefined)) u.blockedOn = false;
  return (u.status || u.owner || u.blockedBy || u.blockedOn) ? u : undefined;
}

function fillFromCreate(ex, rec) {
  const u = ex.unknown;
  const out = { unknown: undefined };
  if (!u) return out;
  if (u.status) out.status = rec.status;
  if (u.owner) out.owner = rec.owner || '';
  if (u.blockedBy) out.blockedBy = [...new Set([...(rec.blockedBy || []), ...(ex.blockedBy || [])])];
  if (u.blockedOn) out.blockedOn = rec.blockedOn;
  return out;
}

// Normalize an owner field to a trimmed string ('' = unowned). Mirror task-guard.
function normOwner(o) {
  return typeof o === 'string' ? o.trim() : '';
}

// Normalize a blockedBy field to an array of string ids. Mirror task-guard.
function normBlockedBy(b) {
  if (Array.isArray(b)) return b.filter(x => x != null).map(x => String(x));
  if (b != null && (typeof b === 'string' || typeof b === 'number')) return [String(b)];
  return [];
}

// classifyOpen(open, taskMap) — ACTIONABLE-NOW set (mirror task-guard exactly):
// status pending AND unowned (or owner main/orchestrator/coordinator) AND no OPEN
// blocker (every blockedBy id absent or in a done/completed/cancelled state).
function classifyOpen(open, taskMap) {
  // A blocker whose id is NOT in the map (dangling/unknown) is the SAFER default
  // treated as STILL OPEN — cannot prove resolved, so the task is blocked (NOT
  // actionable). Mirror task-guard exactly.
  const known = new Set();
  const notDone = new Set();
  for (const t of taskMap.values()) {
    known.add(String(t.id));
    const s = (t.status || '').toLowerCase();
    if (s !== 'completed' && s !== 'done' && s !== 'cancelled' && s !== 'canceled') notDone.add(String(t.id));
  }
  const actionable = [];
  for (const t of open) {
    const s = (t.status || '').toLowerCase();
    if (s !== 'pending') continue;
    if (!isIdleCandidate(t)) continue; // block state unproven: may be waiting on the owner
    const owner = normOwner(t.owner);
    if (owner && !/^(main|orchestrator|coordinator)$/i.test(owner)) continue;
    // Explicit owner/user/external marker => not dispatchable (mirror task-guard).
    if (DD.isOwnerBlocked(t)) continue;
    const blockers = normBlockedBy(t.blockedBy);
    if (blockers.some(id => { const k = String(id); return notDone.has(k) || !known.has(k); })) continue;
    actionable.push(t);
  }
  return actionable;
}

function collectTU(node) {
  if (!node || typeof node !== 'object') return [];
  const out = [];
  if (node.type === 'tool_use' && node.name) out.push(node);
  for (const k of ['content', 'message', 'messages', 'tool_uses', 'parts']) {
    const v = node[k];
    if (Array.isArray(v)) for (const it of v) out.push(...collectTU(it));
    else if (v && typeof v === 'object') out.push(...collectTU(v));
  }
  return out;
}


module.exports = { reconstructTasks, classifyOpen, normOwner, normBlockedBy, collectTU, unseenTask, gapsAfterUpdate, fillFromCreate, isOpenTask, isIdleCandidate, openOf, unknownOf, unknownNote };
