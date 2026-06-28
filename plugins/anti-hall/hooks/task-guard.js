#!/usr/bin/env node
// anti-hall :: task-guard (Stop hook, loop-safe)
//
// Fires on Stop. Checks whether the session's task list still has open tasks.
// If so, blocks to prompt the model to continue or explicitly defer them.
//
// SHARP MODE — IDLE NEGLECT (the orchestrator's #1 failure): if there is at
// least one ACTIONABLE-NOW task (status pending, unowned, no OPEN blocker) AND no
// subagent is currently in flight (no FRESH ~/.anti-hall/agents/<id>.json
// heartbeat), the orchestrator is sitting on dispatchable work — we block with a
// SPECIFIC reason naming those tasks and demanding parallel dispatch. If agents
// ARE running, or the only open tasks are blocked/owned/in_progress, we fall back
// to the gentler generic nudge (don't nag genuine parallel work or genuine
// waiting on real blockers).
//
// Loop-safety: if the exact same set was already blocked on last Stop, we do NOT
// block again; the idle-neglect block dedupes on (actionable-set + "no-agents")
// so it re-fires only when that set changes, and an absolute MAX_BLOCKS cap
// (counting BOTH modes) guarantees no hard loop even when the set keeps churning.
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { transcript_path, session_id?, cwd?, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to block, or nothing.
//   exit 0 : always - fail-open on any error so a bug never hard-loops Claude.
//
// Design (OS-agnostic - pure Node built-ins, fd-0 stdin, os.tmpdir state):
//   - Reads a bounded trailing window of the transcript JSONL (512 KB by
//     default) so a multi-GB transcript can never OOM/stall the hook. A task
//     that lives entirely before the window is not seen, which can only suppress
//     a block (fail-open), never cause a false one.
//   - Discovers tasks from TodoWrite tool_use entries (input.todos[]) AND
//     TaskCreate/TaskUpdate entries; replays in order, last state wins.
//   - TaskCreate / TaskUpdate keying: the harness assigns a sequential numeric
//     ID (1, 2, 3 ...) but does NOT include it in the tool_use input; it appears
//     only in the tool_result text "Task #N created successfully: <subject>".
//     TaskUpdate references this ID via the field "taskId" (not "id"/"task_id").
//     The parser therefore:
//       (a) parses tool_result strings to map tool_use_id -> numeric task id,
//       (b) on TaskCreate uses the tool_use id as a provisional key until the
//           result is seen, then remaps to the numeric key,
//       (c) on TaskUpdate reads inp.taskId (plus inp.id / inp.task_id as
//           fallbacks) so completions are correctly applied.
//   - Loop-state file lives under ~/.anti-hall/ keyed by session_id
//     (F-07: never written into the user's project tree, so it does not pollute
//     a stranger's repo or show as dirty git status, and dedupe survives `cd`).
//     It stores JSON { hash, blocks } - a hash of the sorted open-task
//     identifiers from the last block, plus a running count of how many times we
//     have blocked this session.
//   - HARD BLOCK CAP (loop-safety): the byte-identical-set dedupe only catches a
//     frozen list. In the normal flow the model reacts to a block by completing
//     or adding a task, so the set CHANGES every Stop and the hash dedupe never
//     fires - re-blocking forever. So we also cap total blocks per session
//     (MAX_BLOCKS); once reached we stay quiet regardless of set churn.
//   - NEVER throws: all logic is wrapped in a top-level try/catch -> exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function main() {
  // Read stdin synchronously (fd 0 - cross-platform; /dev/stdin is Windows-unsafe).
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('task-guard')) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  const transcriptPath = payload && payload.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    process.exit(0);
  }

  // Loop-state under a per-user temp dir keyed by session_id (F-07). Fall back
  // to a stable hash of the transcript path when session_id is absent so dedupe
  // still works per-session without touching the project tree.
  const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
    crypto.createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16);
  const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
  // Session-scoped loop-state under ~/.anti-hall/ (not os.tmpdir) for consistency
  // and cross-runner visibility; still keyed by session_id so dedupe is per-session.
  const stateDir = path.join(os.homedir(), '.anti-hall');
  const stateFile = path.join(stateDir, 'last-stop-taskset-' + safeSession);

  // Parse tasks by streaming the transcript lines.
  let taskMap;
  try {
    taskMap = parseTasksFromFile(transcriptPath);
  } catch (_) {
    process.exit(0);
  }

  // Compute open tasks.
  const openTasks = [];
  for (const task of taskMap.values()) {
    const s = (task.status || '').toLowerCase();
    if (s === 'pending' || s === 'in_progress' || s === 'in-progress') {
      openTasks.push(task);
    }
  }

  if (openTasks.length === 0) {
    try { fs.unlinkSync(stateFile); } catch (_) {}
    process.exit(0);
  }

  // Classify: which open tasks are ACTIONABLE NOW (pending, unowned, no open
  // blocker) and is any subagent in flight? These drive the SHARP idle-neglect
  // block vs the gentler generic nudge.
  const actionable = classifyOpen(openTasks, taskMap);
  const haveAgents = agentsRunning();
  // IDLE NEGLECT = there is dispatchable work AND nothing is running. If agents
  // are in flight, or the only open tasks are blocked/owned/in_progress, this is
  // false (don't nag genuine parallel work or genuine waiting on blockers).
  const idleNeglect = actionable.length >= 1 && !haveAgents;

  // Hash basis differs per mode so the two block types dedupe independently:
  //  - idle-neglect: hash of the ACTIONABLE set + a "no-agents" tag, so it
  //    re-fires only when the actionable set changes (still capped, see below).
  //  - generic: hash of the full open-task set (legacy behavior).
  let hash;
  if (idleNeglect) {
    const aids = actionable.map(t => String(t.id || t.content || t.subject || '')).sort();
    hash = crypto.createHash('sha1')
      .update('idle\x00no-agents\x00' + aids.join('\x00')).digest('hex');
  } else {
    const ids = openTasks.map(t => String(t.id || t.content || t.subject || '')).sort();
    hash = crypto.createHash('sha1').update(ids.join('\x00')).digest('hex');
  }

  // Load prior loop-state: { hash, blocks }. Tolerate the legacy plain-hash
  // format (a bare hex string from an older version) so an upgrade in place does
  // not lose dedupe.
  let lastHash = '';
  let blocks = 0;
  try {
    const rawState = fs.readFileSync(stateFile, 'utf8').trim();
    if (rawState) {
      try {
        const parsed = JSON.parse(rawState);
        if (parsed && typeof parsed === 'object') {
          lastHash = typeof parsed.hash === 'string' ? parsed.hash : '';
          blocks = Number.isFinite(parsed.blocks) ? parsed.blocks : 0;
        } else {
          lastHash = rawState; // legacy bare-hash file
        }
      } catch (_) {
        lastHash = rawState; // legacy bare-hash file
      }
    }
  } catch (_) {
    // First time or cleared.
  }

  // Loop-safety 1: if we already blocked on this exact set, don't block again.
  if (hash === lastHash) {
    process.exit(0); // already nudged for this exact set; nothing changed
  }

  // Loop-safety 2: hard cap on total blocks this session. The set legitimately
  // changes as the model works through tasks, which defeats the byte-identical
  // dedupe; without a cap we would re-block on every Stop forever. After
  // MAX_BLOCKS nudges we stay quiet regardless of churn. Modestly raised to 5 so
  // a genuinely-stuck actionable set can still re-nudge a few times when it
  // changes, but can NEVER hard-loop (cap is absolute, counts both modes).
  const MAX_BLOCKS = 5;
  if (blocks >= MAX_BLOCKS) {
    process.exit(0);
  }

  // OMC-awareness: if an autonomous OMC loop (ralph, ultrawork, autopilot, etc.)
  // is active, SUPPRESS the Stop block entirely — emit a one-line advisory and
  // exit 0 instead. This prevents task-guard from deadlocking against the loop.
  // The block is NOT counted against the budget (no state write). If detection
  // fails for any reason, we fall through to the normal block (fail-open = guard
  // stays active, never silent).
  try {
    const { isOmcLoopActive } = require('./omc-detect.js');
    const cwd = payload && payload.cwd;
    const sid = (payload && payload.session_id && String(payload.session_id)) || undefined;
    if (isOmcLoopActive({ cwd, sessionId: sid })) {
      // fs.writeSync(1): process.stdout.write races the async pipe flush with
      // exit() on macOS node 18/20 (repo-wide rule for hook output).
      fs.writeSync(1,
        '[task-guard] OMC autonomous loop active — deferring Stop block to avoid deadlock.\n'
      );
      process.exit(0);
    }
  } catch (_) {
    // detection error → fall through to normal block
  }

  // Write the new state before blocking (so a no-op next Stop won't re-block and
  // the cap is enforced even if the set keeps changing).
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ hash, blocks: blocks + 1 }), 'utf8');
  } catch (_) {
    process.exit(0); // can't persist -> fail-open to avoid loops
  }

  // Build the block reason. Two modes:
  //  - IDLE NEGLECT (sharp): name the ACTIONABLE-NOW tasks and demand parallel
  //    dispatch — the user's #1 pain is the orchestrator sitting on dispatchable
  //    work with no agents running.
  //  - GENERIC (gentle): work is in flight or the only open tasks are
  //    blocked/owned/in_progress — nudge to drain but don't accuse of neglect.
  const renderList = (arr) => arr.slice(0, 5).map(t => {
    const rawSubject = t.content || t.subject || t.id || '(unknown)';
    // Sanitize: strip control chars/newlines and truncate to ~60 chars so a
    // TodoWrite item's text cannot inject instruction-like content into the Stop
    // reason. Does not change which tasks are listed, only how the subject reads.
    const subject = sanitizeSubject(rawSubject) || '(unknown)';
    const status = sanitizeSubject(t.status || 'open', 24) || 'open';
    // JSON.stringify the subject (and status) so a subject containing a literal
    // " renders cleanly and matches task-tracker.js's approach (symmetry). The
    // whole reason is JSON.stringify'd anyway, so this is cleanliness, not safety.
    return JSON.stringify(subject) + ' [' + JSON.stringify(status) + ']';
  }).join('; ');

  let reason;
  if (idleNeglect) {
    const list = renderList(actionable);
    const more = actionable.length > 5 ? ' (and ' + (actionable.length - 5) + ' more)' : '';
    reason =
      'IDLE NEGLECT: ' + actionable.length + ' non-blocked, unassigned task(s) and ' +
      'NO agents running — dispatch them in PARALLEL NOW (one background agent ' +
      'each, cap ~min(16, cores-2)): ' + list + more + '. ' +
      'Do not end the turn idle; only stop if a task truly needs the user (then ' +
      'say which + why).';
  } else {
    const list = renderList(openTasks);
    const more = openTasks.length > 5 ? ' (and ' + (openTasks.length - 5) + ' more)' : '';
    reason =
      'Open tasks remain and the session is stopping: ' + list + more + '. ' +
      'Actively drain the task list: pick up pending tasks and dispatch subagents to ' +
      'finalize them; run independent tasks in parallel (up to the concurrency cap, ' +
      '~min(16, cores-2)); do not let tasks sit neglected. ' +
      'Continue them, mark them completed or deferred via TaskUpdate, or tell the user ' +
      'explicitly what is pending and why you are stopping.';
  }

  // fs.writeSync(1): stdout.write races the async pipe flush with exit() on
  // macOS node 18/20 (repo-wide hook-output rule; R2-N1).
  try { fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n'); } catch (_) {}
  process.exit(0);
}

// Read a bounded trailing window of the transcript JSONL (see readTranscriptTail)
// and build Map<id, {id, content, status}> (last write wins). The window keeps a
// multi-GB transcript from OOM-ing/stalling the hook. Tradeoff: a TaskCreate that
// occurred before the window and was never updated within it is not seen — which
// can only suppress a block (fail-open), never cause a false one. Lines that fail
// to parse are skipped.
//
// Key insight (verified against real transcripts, 2026-05-31):
//
//   TaskCreate input has NO id / task_id field. The harness assigns a sequential
//   numeric id (1, 2, 3 ...) and returns it only in the tool_result string:
//     "Task #1 created successfully: <subject>"
//   TaskUpdate uses the field "taskId" (camelCase) — NOT "id" or "task_id".
//
//   The old code keyed TaskCreate by Date.now()+random (id never present) and
//   read TaskUpdate via inp.id||inp.task_id (both always null), so NO update ever
//   matched ANY create, and ALL creates stayed pending forever. That caused the
//   false-block of 34 "pending" tasks when the harness TaskList showed 0.
//
//   Fix: two-pass strategy within a single scan:
//     1. Collect tool_result strings that say "Task #N created successfully" and
//        map the tool_use_id (e.g. "toolu_01...") -> numeric key "N".
//     2. On TaskCreate, store provisionally under the tool_use id.
//     3. After the full scan, remap provisional keys to numeric keys using the
//        result map (entries whose tool_use id appears in the result map get
//        re-keyed; others stay as their tool_use id — still valid for dedup).
//     4. On TaskUpdate, check inp.taskId first, then inp.id, then inp.task_id.
// Bounded tail read: load only the last `windowBytes` of a possibly multi-GB
// transcript instead of the whole file, so a huge transcript can never OOM or
// stall this hook. If the file is smaller than the window we read it all. Any
// error -> null (caller returns an empty task map -> no block, fail-open).
function readTranscriptTail(transcriptPath, windowBytes) {
  const WINDOW = windowBytes || 512 * 1024;
  let fd = null;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= WINDOW) {
      return { data: fs.readFileSync(transcriptPath, 'utf8'), truncated: false };
    }
    const start = size - WINDOW;
    const buf = Buffer.alloc(WINDOW);
    fd = fs.openSync(transcriptPath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, WINDOW, start);
    return { data: buf.toString('utf8', 0, bytesRead), truncated: true };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

// Strip control chars + newlines and truncate to keep a task subject from
// injecting instruction-like content (or breaking JSON layout) when embedded in
// the Stop reason. Does NOT change which tasks are listed — only the rendered
// string. Non-string input collapses to ''.
function sanitizeSubject(s, maxLen) {
  const cap = maxLen || 60;
  if (typeof s !== 'string') return '';
  // Replace control chars (C0 0x00-0x1F, DEL 0x7F, C1 0x80-0x9F) — including
  // newlines/tabs — with spaces, then collapse whitespace runs so nothing in a
  // task subject can reshape the Stop reason or inject instruction-like lines.
  let out = s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (out.length > cap) out = out.slice(0, cap).trimEnd() + '…';
  return out;
}

// Normalize an owner field to a trimmed string ('' = unowned). The harness owner
// is an agent id string; anything non-string collapses to ''.
function normOwner(o) {
  return typeof o === 'string' ? o.trim() : '';
}

// Normalize a blockedBy field to an array of string task ids. The harness sends a
// list of open task ids that must resolve first; tolerate a single id or junk.
function normBlockedBy(b) {
  if (Array.isArray(b)) return b.filter(x => x != null).map(x => String(x));
  if (b != null && (typeof b === 'string' || typeof b === 'number')) return [String(b)];
  return [];
}

// agentsRunning() — true if ~/.anti-hall/agents/ holds at least one FRESH
// heartbeat (an in-flight subagent). Matches how agent-watchdog.js reads them:
// each file is <id>.json with a numeric `ts` (epoch ms). Fresh = ts within
// FRESH_MS; we also accept file mtime as a fallback when ts is missing/old, so a
// just-touched heartbeat still counts. Absent/unreadable dir => false (no agents)
// — fail-open toward "not running", which can only PERMIT an idle-neglect nudge,
// never silence one falsely while work is genuinely in flight (the dir IS written
// when agents run). Any error => false.
function agentsRunning(freshMs) {
  const FRESH = freshMs || 20 * 60 * 1000; // ~20 min, matches agent-watchdog
  const dir = path.join(os.homedir(), '.anti-hall', 'agents');
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch (_) {
    return false; // no dir / unreadable => no agents
  }
  const now = Date.now();
  for (const f of files) {
    const full = path.join(dir, f);
    let ts = 0;
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (data && typeof data.ts === 'number') ts = data.ts;
    } catch (_) { /* fall back to mtime */ }
    if (!ts) {
      try { ts = fs.statSync(full).mtimeMs; } catch (_) { ts = 0; }
    }
    if (ts && (now - ts) < FRESH) return true;
  }
  return false;
}

// normPriority — normalize a raw priority value to a trimmed string or null.
// Non-string/blank collapses to null (treated as missing → actionable P1).
function normPriority(p) {
  if (p == null) return null;
  const s = String(p).trim();
  return s || null;
}

// isActionablePriority — returns true when a task's priority should trigger
// idle-neglect nagging. P0/P1 and missing/unknown = actionable (fail-open: never
// under-nag a real high-priority task). Only an EXPLICIT P2 (or "low"/"deferred")
// is treated as non-nagging backlog. Garbage/unrecognized values → actionable.
function isActionablePriority(p) {
  if (p == null || p === '') return true; // missing → treat as P1
  const s = String(p).trim().toLowerCase();
  return s !== 'p2' && s !== 'low' && s !== 'deferred';
}

// classifyOpen(openTasks) — split open tasks into ACTIONABLE-NOW vs the rest.
// ACTIONABLE NOW = status pending AND unowned (no owner, or owner is the main
// thread) AND no OPEN blocker (every blockedBy id is either absent from the map
// or already in a done/completed state) AND priority P0/P1 (missing → P1).
// P2/low/deferred tasks are NON-NAGGING backlog and never trigger idle-neglect.
// in_progress / owned / blocked tasks are NOT actionable — the orchestrator is
// either working them or genuinely waiting.
function classifyOpen(openTasks, taskMap) {
  // Build sets of (a) ids present in the map and (b) ids that are NOT done (so a
  // blocker pointing at them is "open"). A blocker whose id is NOT in the map at
  // all (dangling/unknown) is the SAFER default treated as STILL OPEN — we cannot
  // prove it resolved, so the task is considered blocked (NOT actionable),
  // suppressing a possible false block rather than risking one.
  const known = new Set();
  const notDone = new Set();
  for (const t of taskMap.values()) {
    known.add(String(t.id));
    const s = (t.status || '').toLowerCase();
    if (s !== 'completed' && s !== 'done' && s !== 'cancelled' && s !== 'canceled') {
      notDone.add(String(t.id));
    }
  }
  const actionable = [];
  for (const t of openTasks) {
    const s = (t.status || '').toLowerCase();
    if (s !== 'pending') continue; // in_progress => already being worked
    const owner = normOwner(t.owner);
    // Owned by a subagent => not the main thread's to dispatch. Treat "main"/
    // "orchestrator"/"coordinator" owner labels as the main thread (still ours).
    if (owner && !/^(main|orchestrator|coordinator)$/i.test(owner)) continue;
    const blockers = normBlockedBy(t.blockedBy);
    // A blocker is OPEN if it is not-done OR unknown (dangling id => assume open).
    const hasOpenBlocker = blockers.some(id => {
      const k = String(id);
      return notDone.has(k) || !known.has(k);
    });
    if (hasOpenBlocker) continue;
    // Priority filter: only P0/P1 (or missing) tasks trigger idle-neglect.
    // P2/low/deferred is non-nagging backlog — never count toward idle-neglect.
    if (!isActionablePriority(t.priority)) continue;
    actionable.push(t);
  }
  return actionable;
}

function parseTasksFromFile(filePath) {
  const tail = readTranscriptTail(filePath);
  if (!tail) {
    return new Map();
  }
  const lines = tail.data.split(/\r?\n/);
  // The first line of a mid-file window may be a truncated partial JSON line;
  // drop it so the parser never sees a fragment.
  if (tail.truncated && lines.length > 0) {
    lines.shift();
  }

  // provisional storage: tool_use_id -> task record
  const provisionalMap = new Map(); // tool_use_id -> { toolUseId, content, status }
  // final task map: numeric-or-fallback id -> task record
  const taskMap = new Map();
  // result map: tool_use_id -> numeric string id ("1", "2", ...)
  const resultIdMap = new Map(); // tool_use_id -> "N"

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }

    // Collect TaskCreate tool_results from user messages.
    // Shape: { type:"user", message:{ content:[ { type:"tool_result",
    //   tool_use_id:"toolu_...", content:"Task #N created successfully: ..." } ] } }
    if (entry.type === 'user') {
      const msg = entry.message;
      const content = msg && Array.isArray(msg.content) ? msg.content : [];
      for (const item of content) {
        if (item && item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
          const resultText = typeof item.content === 'string' ? item.content : '';
          const m = resultText.match(/^Task\s+#(\d+)\s+created\s+successfully/i);
          if (m) {
            resultIdMap.set(item.tool_use_id, m[1]);
          }
        }
      }
    }

    const toolUses = collectToolUses(entry);
    for (const tu of toolUses) {
      const name = tu.name || '';

      if (name === 'TodoWrite') {
        const todos = tu.input && tu.input.todos;
        if (Array.isArray(todos)) {
          // TodoWrite replaces the entire list — clear both maps.
          taskMap.clear();
          provisionalMap.clear();
          for (const todo of todos) {
            const id = todo.id || todo.content || String(taskMap.size);
            taskMap.set(String(id), {
              id: String(id),
              content: todo.content || todo.activeForm || String(id),
              status: todo.status || 'pending',
              // TodoWrite items have no owner/dependency model — they are the
              // main thread's own list, so they count as unowned + unblocked
              // (i.e. always actionable when pending).
              owner: normOwner(todo.owner),
              blockedBy: normBlockedBy(todo.blockedBy),
              priority: normPriority(
                (todo.metadata != null && todo.metadata.priority != null)
                  ? todo.metadata.priority : todo.priority
              ),
            });
          }
        }
        continue;
      }

      if (name === 'TaskCreate') {
        // The harness-assigned numeric id is NOT in input; it comes back via
        // tool_result. Store provisionally under the tool_use wire id (tu.id).
        const inp = tu.input || {};
        const toolUseId = tu.id || '';
        const content = inp.subject || inp.title || inp.content || inp.description || toolUseId;
        const status = inp.status || 'pending';
        // owner / blockedBy may be absent at create-time (set later via
        // TaskUpdate) — capture if present so a single-shot create with deps is
        // still classified correctly.
        const owner = normOwner(inp.owner);
        const blockedBy = normBlockedBy(inp.blockedBy);
        // Priority: check inp.metadata.priority first (harness convention), then
        // inp.priority as a fallback. Missing/null → null (treated as P1 later).
        const priority = normPriority(
          (inp.metadata != null && inp.metadata.priority != null)
            ? inp.metadata.priority : inp.priority
        );
        if (toolUseId) {
          provisionalMap.set(toolUseId, { toolUseId, content, status, owner, blockedBy, priority });
        }
        continue;
      }

      if (name === 'TaskUpdate') {
        const inp = tu.input || {};
        // Real harness uses "taskId"; also accept "id" and "task_id" as fallbacks.
        const id = inp.taskId != null ? String(inp.taskId)
                 : inp.id     != null ? String(inp.id)
                 : inp.task_id != null ? String(inp.task_id)
                 : null;
        if (id != null) {
          const existing = taskMap.get(id) || { id, content: id };
          // Priority: only overwrite when the update explicitly carries the field
          // (either inp.priority or inp.metadata.priority). A status-only update
          // must not clear a priority that was set at TaskCreate time.
          const hasPriorityUpdate = inp.priority !== undefined ||
            (inp.metadata != null && inp.metadata.priority !== undefined);
          const updatedPriority = hasPriorityUpdate
            ? normPriority(
                (inp.metadata != null && inp.metadata.priority != null)
                  ? inp.metadata.priority : inp.priority
              )
            : (existing.priority || null);
          taskMap.set(id, {
            id: existing.id,
            content: existing.content,
            status: inp.status || existing.status || 'pending',
            // Only overwrite owner/blockedBy when the update actually carries the
            // field; an unrelated status-only update must not clear them.
            owner: inp.owner !== undefined ? normOwner(inp.owner) : (existing.owner || ''),
            blockedBy: inp.blockedBy !== undefined ? normBlockedBy(inp.blockedBy)
                                                    : (existing.blockedBy || []),
            priority: updatedPriority,
          });
        }
        continue;
      }
    }
  }

  // Flush provisional TaskCreate entries into taskMap using the result id map.
  // If the tool_result was seen, use the numeric key; otherwise fall back to the
  // tool_use id (still unique per task, so dedup and open-task count are correct).
  for (const [toolUseId, rec] of provisionalMap) {
    const numericId = resultIdMap.get(toolUseId) || toolUseId;
    const key = String(numericId);
    // Merge: if taskMap already has this key (from a TaskUpdate that arrived
    // before we flushed), keep its status; otherwise use the provisional status.
    const existing = taskMap.get(key);
    if (!existing) {
      taskMap.set(key, {
        id: key, content: rec.content, status: rec.status,
        owner: rec.owner || '', blockedBy: rec.blockedBy || [],
        priority: rec.priority || null,
      });
    } else if (!existing.content || existing.content === key) {
      // Backfill subject from provisional record (update may have arrived first).
      taskMap.set(key, {
        id: key, content: rec.content, status: existing.status,
        owner: existing.owner || rec.owner || '',
        blockedBy: (existing.blockedBy && existing.blockedBy.length) ? existing.blockedBy : (rec.blockedBy || []),
        priority: existing.priority || rec.priority || null,
      });
    }
    // If existing already has a richer status from TaskUpdate, leave it.
  }

  return taskMap;
}

function collectToolUses(node) {
  if (!node || typeof node !== 'object') return [];
  const results = [];
  if (node.type === 'tool_use' && node.name) {
    results.push(node);
  }
  for (const key of ['content', 'message', 'messages', 'tool_uses', 'parts']) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) results.push(...collectToolUses(item));
    } else if (val && typeof val === 'object') {
      results.push(...collectToolUses(val));
    }
  }
  return results;
}

try {
  main();
} catch (_) {
  process.exit(0);
}
