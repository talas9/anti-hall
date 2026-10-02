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
              windowReset = true;
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
            if (n <= Math.max(maxCreated, DD.maxNumericKey(taskMap))) {
              taskMap.clear();
              for (const tid of [...provisional.keys()]) if (resultIds.has(tid)) provisional.delete(tid);
              resultIds.clear();
              windowReset = true;
            }
            if (firstCreated === Infinity) firstCreated = n;
            maxCreated = n;
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
        toolCallInfo.set(tu.id, { name, taskId });
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
          const ex = taskMap.get(id) || { id, content: id };
          taskMap.set(id, {
            id: ex.id,
            // A TaskUpdate may rename the task or rewrite its description.
            content: typeof inp.subject === 'string' && inp.subject ? inp.subject : ex.content,
            description: typeof inp.description === 'string' ? inp.description : (ex.description || ''),
            subjectUpdated: (typeof inp.subject === 'string' && inp.subject) ? true : ex.subjectUpdated,
            status: inp.status || ex.status || 'pending',
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
    const ex = taskMap.get(key);
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
  const open = [];
  for (const task of taskMap.values()) {
    const s = (task.status || '').toLowerCase();
    if (s === 'pending' || s === 'in_progress' || s === 'in-progress') open.push(task);
  }
  return { open, taskMap, windowReset, firstCreated };
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


module.exports = { reconstructTasks, classifyOpen, normOwner, normBlockedBy, collectTU };
