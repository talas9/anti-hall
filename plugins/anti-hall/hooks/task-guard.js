#!/usr/bin/env node
// anti-hall :: task-guard (Stop hook, loop-safe)
//
// Fires on Stop. Checks whether the session's task list still has open tasks.
// If so, blocks ONCE to prompt the model to continue or explicitly defer them.
// Loop-safety: if the exact same open-task set was already blocked on last Stop,
// we do NOT block again (prevents infinite back-and-forth loops).
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { transcript_path, session_id?, cwd?, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to block, or nothing.
//   exit 0 : always - fail-open on any error so a bug never hard-loops Claude.
//
// Design (OS-agnostic - pure Node built-ins, fd-0 stdin, os.tmpdir state):
//   - Streams the transcript JSONL (no fixed byte window) so an early
//     TodoWrite in a large transcript is never silently missed.
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

  // Hash the sorted open-task identifiers.
  const ids = openTasks.map(t => String(t.id || t.content || t.subject || '')).sort();
  const hash = crypto.createHash('sha1').update(ids.join('\x00')).digest('hex');

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
  // MAX_BLOCKS nudges we stay quiet regardless of churn.
  const MAX_BLOCKS = 3;
  if (blocks >= MAX_BLOCKS) {
    process.exit(0);
  }

  // Write the new state before blocking (so a no-op next Stop won't re-block and
  // the cap is enforced even if the set keeps changing).
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ hash, blocks: blocks + 1 }), 'utf8');
  } catch (_) {
    process.exit(0); // can't persist -> fail-open to avoid loops
  }

  // Build the block reason (list up to 5 subjects + status).
  const cap = openTasks.slice(0, 5);
  const list = cap.map(t => {
    const subject = t.content || t.subject || t.id || '(unknown)';
    const status = t.status || 'open';
    return '"' + subject + '" [' + status + ']';
  }).join('; ');
  const more = openTasks.length > 5 ? ' (and ' + (openTasks.length - 5) + ' more)' : '';

  const reason =
    'Open tasks remain and the session is stopping: ' + list + more + '. ' +
    'Actively drain the task list: pick up pending tasks and dispatch subagents to ' +
    'finalize them; run independent tasks in parallel (up to the concurrency cap, ' +
    '~min(16, cores-2)); do not let tasks sit neglected. ' +
    'Continue them, mark them completed or deferred via TaskUpdate, or tell the user ' +
    'explicitly what is pending and why you are stopping.';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

// Stream the whole transcript JSONL and build Map<id, {id, content, status}>
// (last write wins). Reading the file fully then splitting is fine here: it is
// a single synchronous read and we must not miss an early entry (no tail window).
// Lines that fail to parse are skipped.
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
function parseTasksFromFile(filePath) {
  let data;
  try {
    data = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return new Map();
  }
  const lines = data.split(/\r?\n/);

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
        if (toolUseId) {
          provisionalMap.set(toolUseId, { toolUseId, content, status });
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
          taskMap.set(id, {
            id: existing.id,
            content: existing.content,
            status: inp.status || existing.status || 'pending',
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
      taskMap.set(key, { id: key, content: rec.content, status: rec.status });
    } else if (!existing.content || existing.content === key) {
      // Backfill subject from provisional record (update may have arrived first).
      taskMap.set(key, { id: key, content: rec.content, status: existing.status });
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
