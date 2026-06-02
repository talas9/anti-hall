#!/usr/bin/env node
// anti-hall :: tasklist-guard (Stop hook, loop-safe)
//
// Fires on Stop. Enforces that NON-TRIVIAL work performed this session was
// actually TRACKED as tasks AND has a fresh progress file. This COEXISTS with
// task-guard (which checks that DECLARED tasks were drained / not left open):
//   - task-guard      : "you declared tasks — don't stop with them still open."
//   - tasklist-guard  : "you did real work — was it tracked, and is progress fresh?"
// Both can fire on the same Stop; each keeps its OWN independent block cap, so
// the two never compound into a runaway loop.
//
// BLOCK iff (and the guard is not skipped):
//   WORK_COUNT >= threshold  AND  ( no task activity seen
//                                   OR a task left in_progress (stale)
//                                   OR no fresh .anti-hall-progress.md ).
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { session_id, transcript_path, cwd, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to block, or nothing.
//   exit 0 : ALWAYS — fail-open on any error so a hook bug never hard-loops Claude.
//            Plugin caveat (KB §): plugin-packaged Stop hooks do NOT reliably
//            continue on exit 2, so we block via the JSON decision form + exit 0,
//            never exit 2.
//
// Cold-start caveat (KB §): transcript_path can be absent / unflushed on the very
// first turn → we exit 0 (fail-open) rather than guess.
//
// State (loop-safety) lives under ~/.anti-hall/ keyed by session_id (never the
// project tree). Stores { hash, blocks }; same signal twice → no re-block; a hard
// MAX_BLOCKS cap stops churn-driven loops.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// DEFERRED (accepted): (a) cumulative work counters vs the 512 KB tail clip — work
// before the window is unseen, which can only SUPPRESS a block (fail-open, the safe
// direction); (b) sync-I/O stall on a network-mounted cwd — the harness 30 s hook
// timeout makes a non-block (fail-open) the outcome. Neither is fixed here by design.
const MAX_BLOCKS = 3;
const DEFAULT_WORK_THRESHOLD = 3;
const DEFAULT_PROGRESS_FRESH_MS = 30 * 60 * 1000; // 1,800,000 ms
const PROGRESS_FILE = '.anti-hall-progress.md';

// File-mutating tool names (each tool_use = +1 to WORK_COUNT).
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// A Bash command counts as work when it commits or writes. This is a FAIL-OPEN
// nudge heuristic only — Edit/Write/MultiEdit/NotebookEdit remain the primary +1
// work signals; this just improves Bash coverage. All branches are ReDoS-safe (no
// nested quantifiers; only simple \s*/\s+; linear). Built via concatenated strings
// + new RegExp with the `m` flag so `^` matches at the start of EACH line.
//
//   (1) ALWAYS-work tokens, matched anywhere in the command:
//         git commit/rebase/merge/cherry-pick/stash/reset/apply/am
//         git checkout/switch/restore/clean
//         tee · mkdir · touch · make · chmod · sed -i
//         npm install|i|ci · (pnpm|yarn) add|install · pip install
//   (2) COMMAND-POSITION-ONLY bare verbs (rm / cp / mv): these over-match inside
//       quoted strings or URL-ish paths like "/cp/" if matched anywhere, so we
//       anchor them to command position — start-of-line (m-flag), or immediately
//       after one of:  ; & |  ( ` $(  or a newline — each optionally followed by
//       whitespace. This catches command-substitution / subshell contexts:
//         (rm f)   echo $(rm f)   echo `rm f`   "...\nrm f"
//   (3) SHELL REDIRECT > / >> : shell syntax with no quoted-word ambiguity, so it
//       matches ANYWHERE (un-anchored): `cmd > out.txt`, `cmd >> log`.
const CMD_BOUNDARY = '(?:^|[;&|`(]|\\$\\(|\\n)\\s*';
const BASH_WORK_RE = new RegExp(
  '(' +
    // (1) always-work, anywhere
    '\\bgit\\s+(?:commit|rebase|merge|cherry-pick|stash|reset|apply|am)\\b' +
    '|\\bgit\\s+(?:checkout|switch|restore|clean)\\b' +
    '|\\btee\\b' +
    '|\\bmkdir\\b' +
    '|\\btouch\\b' +
    '|\\bmake\\b' +
    '|\\bchmod\\b' +
    '|\\bsed\\s+-i' +
    '|\\bnpm\\s+(?:install|i|ci)\\b' +
    '|\\b(?:pnpm|yarn)\\s+(?:add|install)\\b' +
    '|\\bpip\\s+install\\b' +
    // (2) command-position-only bare verbs
    '|' + CMD_BOUNDARY + '(?:rm|cp|mv)\\b' +
    // (3) redirect, un-anchored (shell syntax)
    '|>>?' +
  ')',
  'im'
);

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }

  const { isSkipped } = require('./skip-guard.js');
  if (isSkipped('tasklist-guard')) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  const transcriptPath = payload && payload.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    process.exit(0); // cold-start fail-open
  }

  // Single-pass scan: WORK_COUNT, sawTaskActivity, and reconstructed task state.
  let scan;
  try {
    scan = scanTranscript(transcriptPath);
  } catch (_) {
    process.exit(0);
  }

  const threshold = readThreshold();
  const workCount = scan.workCount;
  const sawTaskActivity = scan.sawTaskActivity;
  const hasStaleInProgress = scan.hasStaleInProgress;
  const openTaskIds = scan.openTaskIds;

  // Progress-file freshness — relative to the session's cwd.
  //
  // Fail-open layering (FIX 5): we stat the cwd DIRECTORY first. If cwd is absent
  // from the payload, not a string, or unreadable (stat throws → e.g. cwd no
  // longer exists), we treat progress as fresh and never block on an environment
  // we cannot inspect. We only set progressFresh = false when the cwd EXISTS but
  // the progress file is absent or stale — that is the case we actually want to nudge.
  //
  // FIX 4: use lstatSync (not statSync) and require a real regular file. A
  // directory named .anti-hall-progress.md would always look "fresh" (a dir mtime
  // bumps on any child change); a SYMLINK could spoof freshness by pointing at an
  // always-touched file. lstat does not follow the link, and st.isFile() rejects
  // both a directory and a symlink — only a real regular file counts as progress.
  const cwd = payload && payload.cwd;
  let progressFresh = true;
  if (cwd && typeof cwd === 'string') {
    let cwdExists = false;
    try {
      cwdExists = fs.statSync(cwd).isDirectory();
    } catch (_) {
      cwdExists = false; // cwd missing/unreadable → fail-open below
    }
    if (!cwdExists) {
      progressFresh = true; // FIX 5: cwd unreadable → fail-open, do not block
    } else {
      try {
        const pPath = path.join(cwd, PROGRESS_FILE);
        const st = fs.lstatSync(pPath); // FIX 4: lstat — do NOT follow symlinks
        if (!st.isFile()) {
          progressFresh = false; // a dir or symlink named like the file ≠ real progress
        } else {
          const age = Date.now() - st.mtimeMs;
          progressFresh = age <= readFreshMs();
        }
      } catch (_) {
        // cwd EXISTS but the progress file is absent (ENOENT) → not fresh → nudge.
        progressFresh = false;
      }
    }
  } else {
    progressFresh = true; // no cwd → can't locate the file → fail-open
  }

  // Below the work threshold → trivial session → never block.
  if (workCount < threshold) {
    process.exit(0);
  }

  const shouldBlock = !sawTaskActivity || hasStaleInProgress || !progressFresh;
  if (!shouldBlock) {
    process.exit(0);
  }

  // --- loop-safety state -----------------------------------------------------
  const sessionId =
    (payload && payload.session_id && String(payload.session_id)) ||
    crypto.createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16);
  const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
  const stateDir = path.join(os.homedir(), '.anti-hall');
  const stateFile = path.join(stateDir, 'tasklist-guard-state-' + safeSession + '.json');

  // Dedup signal = bucketed work + the three sub-causes + a hash of open task ids.
  const workBucket = Math.min(Math.floor(workCount / threshold), 8);
  const openHash = crypto
    .createHash('sha1')
    .update(openTaskIds.slice().sort().join('\x00'))
    .digest('hex')
    .slice(0, 16);
  const signal = [
    workBucket,
    sawTaskActivity ? 1 : 0,
    hasStaleInProgress ? 1 : 0,
    progressFresh ? 1 : 0,
    openHash,
  ].join('|');
  const hash = crypto.createHash('sha1').update(signal).digest('hex');

  let lastHash = '';
  let blocks = 0;
  try {
    const rawState = fs.readFileSync(stateFile, 'utf8').trim();
    if (rawState) {
      const parsed = JSON.parse(rawState);
      if (parsed && typeof parsed === 'object') {
        lastHash = typeof parsed.hash === 'string' ? parsed.hash : '';
        blocks = Number.isFinite(parsed.blocks) ? parsed.blocks : 0;
      }
    }
  } catch (_) {
    // first time / cleared
  }

  if (hash === lastHash) {
    process.exit(0); // already nudged for this exact signal
  }
  if (blocks >= MAX_BLOCKS) {
    process.exit(0); // hard cap — never loop on churn
  }

  // Pick the MOST-SPECIFIC sub-cause for the lead sentence.
  let lead;
  if (!sawTaskActivity) {
    lead =
      'You made ' + workCount + ' file-changing actions this session but tracked ' +
      'NO tasks.';
  } else if (hasStaleInProgress) {
    lead =
      'Multiple tasks are in_progress at once after ' + workCount + ' file-changing ' +
      'actions — keep one task in_progress at a time; the rest look stale.';
  } else {
    lead =
      'You made ' + workCount + ' file-changing actions but ' +
      '.anti-hall-progress.md is missing or stale.';
  }

  const reason = sanitizeReason(
    lead +
      ' Capture this work as priority-sorted tasks via TaskCreate/TaskUpdate ' +
      '(check TaskList FIRST to dedup/relate — do not duplicate an existing task; ' +
      'link related ones with addBlockedBy/addBlocks), set statuses ' +
      '(in_progress/completed), and update .anti-hall-progress.md ' +
      '(done/in-progress/next) — gitignore it so it never ships.'
  );

  // RECONCILED: persist state FIRST, emit the block only if the write SUCCEEDED.
  // The earlier ordering emitted the block before persisting, reasoning that a
  // missed write costs "one extra nudge". That is WRONG when the state dir is
  // unwritable: every Stop re-derives the same (block-causing) signal, the
  // blocks-counter never accumulates (each write fails), so MAX_BLOCKS never
  // caps and the block recurs forever — an infinite Stop loop with no escape.
  // Without a working cap, blocking is unsafe, so we fail-OPEN: if the persist
  // throws/fails, exit 0 WITHOUT emitting a block. We only block when the cap
  // state was durably written (so the dedup + MAX_BLOCKS cap can actually fire).
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ hash, blocks: blocks + 1 }), 'utf8');
  } catch (_) {
    process.exit(0); // can't persist the cap -> fail-open, do not block (no loop)
  }

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(0);
}

function readThreshold() {
  const v = parseInt(process.env.ANTIHALL_TASKLIST_WORK_THRESHOLD || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WORK_THRESHOLD;
}

function readFreshMs() {
  const v = parseInt(process.env.ANTIHALL_PROGRESS_FRESH_MS || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_PROGRESS_FRESH_MS;
}

// sanitizeReason — single line, no control chars, bounded length so a task
// subject or path can't reshape the Stop reason or inject instruction-like lines.
function sanitizeReason(s) {
  if (typeof s !== 'string') return '';
  let out = s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (out.length > 600) out = out.slice(0, 600).trimEnd() + '…';
  return out;
}

// Bounded tail read (mirrors task-guard): only the last windowBytes of a
// possibly multi-GB transcript, so the hook can never OOM/stall. Any error → null.
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

// Single pass over the transcript tail. Computes:
//   - workCount         : file-mutating tool_uses (Edit/Write/MultiEdit/
//                         NotebookEdit + git-commit/write-verb Bash)
//   - sawTaskActivity   : any TaskCreate/TaskUpdate/TodoWrite tool_use present
//   - task state map    : reconstructed (mode-agnostic) to detect in_progress
// Mirrors task-guard's TaskCreate(result-id)/TaskUpdate(taskId)/TodoWrite logic.
function scanTranscript(filePath) {
  const tail = readTranscriptTail(filePath);
  if (!tail) {
    return { workCount: 0, sawTaskActivity: false, hasStaleInProgress: false, openTaskIds: [] };
  }
  const lines = tail.data.split(/\r?\n/);
  if (tail.truncated && lines.length > 0) lines.shift();

  let workCount = 0;
  let sawTaskActivity = false;

  const provisionalMap = new Map(); // tool_use_id -> { content, status }
  const taskMap = new Map();        // id -> { id, content, status }
  const resultIdMap = new Map();    // tool_use_id -> "N"

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }

    // TaskCreate results carry the harness-assigned numeric id.
    if (entry.type === 'user') {
      const msg = entry.message;
      const content = msg && Array.isArray(msg.content) ? msg.content : [];
      for (const item of content) {
        if (item && item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
          const resultText = typeof item.content === 'string' ? item.content : '';
          const m = resultText.match(/^Task\s+#(\d+)\s+created\s+successfully/i);
          if (m) resultIdMap.set(item.tool_use_id, m[1]);
        }
      }
    }

    const toolUses = collectToolUses(entry);
    for (const tu of toolUses) {
      const name = tu.name || '';

      if (MUTATING_TOOLS.has(name)) {
        workCount++;
        continue;
      }

      if (name === 'Bash') {
        const cmd = tu.input && typeof tu.input.command === 'string' ? tu.input.command : '';
        if (cmd && BASH_WORK_RE.test(cmd)) workCount++;
        continue;
      }

      if (name === 'TodoWrite') {
        sawTaskActivity = true;
        const todos = tu.input && tu.input.todos;
        if (Array.isArray(todos)) {
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
        sawTaskActivity = true;
        const inp = tu.input || {};
        const toolUseId = tu.id || '';
        const content = inp.subject || inp.title || inp.content || inp.description || toolUseId;
        const status = inp.status || 'pending';
        if (toolUseId) provisionalMap.set(toolUseId, { content, status });
        continue;
      }

      if (name === 'TaskUpdate') {
        sawTaskActivity = true;
        const inp = tu.input || {};
        const id =
          inp.taskId != null ? String(inp.taskId)
          : inp.id != null ? String(inp.id)
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

  // Flush provisional TaskCreate entries into the task map.
  for (const [toolUseId, rec] of provisionalMap) {
    const key = String(resultIdMap.get(toolUseId) || toolUseId);
    const existing = taskMap.get(key);
    if (!existing) {
      taskMap.set(key, { id: key, content: rec.content, status: rec.status });
    } else if (!existing.content || existing.content === key) {
      taskMap.set(key, { id: key, content: rec.content, status: existing.status });
    }
  }

  // FIX 2: a SINGLE in_progress task is the HEALTHY "one-in-progress" invariant
  // and must NOT trigger a block. Only MORE THAN ONE in_progress at once is a
  // smell (work fragmented / tasks left dangling). So count in_progress and set
  // the sub-cause only when the count exceeds one.
  let inProgressCount = 0;
  const openTaskIds = [];
  for (const task of taskMap.values()) {
    const s = (task.status || '').toLowerCase();
    if (s === 'in_progress' || s === 'in-progress') {
      inProgressCount++;
      openTaskIds.push(String(task.id));
    } else if (s === 'pending') {
      openTaskIds.push(String(task.id));
    }
  }
  const hasStaleInProgress = inProgressCount > 1;

  return { workCount, sawTaskActivity, hasStaleInProgress, openTaskIds };
}

function collectToolUses(node) {
  if (!node || typeof node !== 'object') return [];
  const results = [];
  if (node.type === 'tool_use' && node.name) results.push(node);
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
