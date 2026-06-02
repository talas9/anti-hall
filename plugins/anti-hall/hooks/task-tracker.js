#!/usr/bin/env node
// anti-hall :: task-list discipline injector (UserPromptSubmit, THROTTLED)
//
// Fires on every UserPromptSubmit, but does NOT inject the full task directive
// every turn (that multiplied the per-turn context footprint — the exact bloat
// this plugin warns against). Instead:
//   - FIRST turn of a session (or after the window expires): inject the FULL
//     directive (high-salience primer).
//   - Subsequent turns within the window: inject a SHORT one-line reminder.
// The discipline is never weakened — the full text is delivered at session start
// (and again every window) so capture/priority/drain rules stay present.
//
// Per-session state lives under ~/.anti-hall/ (F-07: never written into the
// user's project tree). Keyed by session_id (fallback: hash of cwd). Conservative
// and FAIL-OPEN: on ANY state error we inject the FULL directive (never less).
//
// Contract (Claude Code UserPromptSubmit hook):
//   stdin  : JSON { session_id, prompt, cwd, transcript_path, ... }
//   stdout : JSON { hookSpecificOutput.additionalContext } added to the turn
//   exit 0 : always - allow prompt, inject context
//
// No external deps; pure Node built-ins. JSON via JSON.stringify.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Bounded tail-scan budget for the per-turn freshness check. Kept small so the
// UserPromptSubmit sweep stays well under its 30s timeout and adds no meaningful
// per-turn cost when there are no open tasks (the note is emitted only then).
const FRESH_SCAN_WINDOW = 256 * 1024;

const FULL =
  'TASK-LIST DISCIPLINE: capture EVERY user request as a task (TaskCreate) ' +
  'before starting work, so no request is lost. Assign each task a priority ' +
  '(metadata.priority: P0/P1/P2) and maintain the list sorted ' +
  'highest-priority-first so the most important work is always on top; work ' +
  'tasks in that order. Keep statuses current: in_progress when starting, ' +
  'completed when done, deferred if explicitly deprioritized. Keep the MAIN ' +
  'thread non-blocking - delegate heavy/long work to background subagents and ' +
  'continue. Report progress to the user. Do not finish a turn with ' +
  'silently-dropped requests.';

const SHORT =
  'TASK-LIST: capture every request as a priority-sorted task; keep statuses ' +
  'current; delegate heavy work; drop nothing.';

// Re-inject the FULL directive at most once per this window (ms). Within the
// window, subsequent turns get only the SHORT one-liner. 6h keeps the full
// primer fresh across a long session without repeating it every turn.
const WINDOW_MS = 6 * 60 * 60 * 1000;

// Tolerance for a stored timestamp slightly ahead of `now` (benign clock skew
// between writes/reads). Anything beyond this in the future is treated as
// corrupt and self-healed. See the future/garbage-timestamp guard below.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// Decide which message to inject. Returns FULL on the first turn of a session or
// when the window has expired; SHORT otherwise. FAIL-OPEN to FULL on any error
// so task discipline is never weakened by a state-file problem.
function pickMessage(payload) {
  try {
    const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
      crypto.createHash('sha1').update(String((payload && payload.cwd) || process.cwd()))
        .digest('hex').slice(0, 16);
    const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const stateDir = path.join(os.homedir(), '.anti-hall');
    const stateFile = path.join(stateDir, 'task-tracker-' + safeSession + '.json');

    const now = Date.now();
    let lastFull = 0;
    try {
      const raw = fs.readFileSync(stateFile, 'utf8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        // FUTURE/GARBAGE-TIMESTAMP GUARD: only trust a stored timestamp that is a
        // finite number AND not in the future (allowing a small clock-skew
        // tolerance). A future or non-finite value (clock skew, timezone error,
        // manual edit, corrupted state) would make `now - lastFull` negative, so
        // `now - lastFull < WINDOW_MS` stays true forever and the FULL directive
        // would NEVER re-show. We reject such values (leave lastFull = 0) so the
        // window is treated as EXPIRED below -> FULL directive + state rewritten
        // to `now`, self-healing the bad value rather than trusting it.
        if (parsed && Number.isFinite(parsed.lastFull) &&
            parsed.lastFull <= now + FUTURE_TOLERANCE_MS) {
          lastFull = parsed.lastFull;
        }
      }
    } catch (_) {
      // No prior state -> first turn -> FULL below.
    }

    if (now - lastFull < WINDOW_MS) {
      // Within a valid past window: short reminder, no state write needed.
      return SHORT;
    }

    // First turn of the session or window expired: inject FULL, record the time.
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ lastFull: now }), 'utf8');
    } catch (_) {
      // Can't persist -> still inject FULL (fail-open: never under-inject).
    }
    return FULL;
  } catch (_) {
    return FULL; // any unexpected error -> never weaken discipline
  }
}

// freshnessNote(payload) — cheap, bounded transcript tail-scan that returns a
// SHORT one-line note ONLY when there are open/stale tasks (an in_progress or
// pending task in the reconstructed state). Returns '' otherwise, so the per-turn
// baseline is NOT bloated when nothing is stale. Fail-open: any error → ''.
function freshnessNote(payload) {
  try {
    const tp = payload && payload.transcript_path;
    if (!tp || typeof tp !== 'string') return '';
    const tail = readTail(tp, FRESH_SCAN_WINDOW);
    if (!tail) return '';
    const state = reconstructTasks(tail);
    const open = state.open;
    if (open.length === 0) return '';
    const inProg = open.find((t) => /in[-_]?progress/i.test(t.status || ''));
    // FIX 7: control-char strip (oneLine) THEN JSON.stringify so the task-supplied
    // subject is rendered as an inert quoted string and can never inject
    // instruction-shaped content into the UserPromptSubmit additionalContext.
    const subj = inProg ? oneLine(inProg.content || inProg.id, 50) : '';
    const tail2 = inProg && subj ? ' (oldest in_progress subject: ' + JSON.stringify(subj) + ')' : '';
    return 'open tasks: ' + open.length + tail2 + ' — update or close them.';
  } catch (_) {
    return '';
  }
}

function readTail(transcriptPath, windowBytes) {
  let fd = null;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= windowBytes) {
      return { data: fs.readFileSync(transcriptPath, 'utf8'), truncated: false };
    }
    const buf = Buffer.alloc(windowBytes);
    fd = fs.openSync(transcriptPath, 'r');
    const n = fs.readSync(fd, buf, 0, windowBytes, size - windowBytes);
    return { data: buf.toString('utf8', 0, n), truncated: true };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// Mode-agnostic task reconstruction (mirrors task-guard / tasklist-guard) → the
// set of OPEN tasks (pending | in_progress). Tolerant + best-effort.
function reconstructTasks(tail) {
  const lines = tail.data.split(/\r?\n/);
  if (tail.truncated && lines.length > 0) lines.shift();
  const provisional = new Map();
  const taskMap = new Map();
  const resultIds = new Map();
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let entry;
    try { entry = JSON.parse(t); } catch (_) { continue; }
    if (entry.type === 'user') {
      const c = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
      for (const it of c) {
        if (it && it.type === 'tool_result' && typeof it.tool_use_id === 'string') {
          const txt = typeof it.content === 'string' ? it.content : '';
          const m = txt.match(/^Task\s+#(\d+)\s+created\s+successfully/i);
          if (m) resultIds.set(it.tool_use_id, m[1]);
        }
      }
    }
    for (const tu of collectTU(entry)) {
      const name = tu.name || '';
      if (name === 'TodoWrite') {
        const todos = tu.input && tu.input.todos;
        if (Array.isArray(todos)) {
          taskMap.clear(); provisional.clear();
          for (const todo of todos) {
            const id = todo.id || todo.content || String(taskMap.size);
            taskMap.set(String(id), { id: String(id), content: todo.content || todo.activeForm || String(id), status: todo.status || 'pending' });
          }
        }
      } else if (name === 'TaskCreate') {
        const inp = tu.input || {};
        const tid = tu.id || '';
        if (tid) provisional.set(tid, { content: inp.subject || inp.title || inp.content || inp.description || tid, status: inp.status || 'pending' });
      } else if (name === 'TaskUpdate') {
        const inp = tu.input || {};
        const id = inp.taskId != null ? String(inp.taskId) : inp.id != null ? String(inp.id) : inp.task_id != null ? String(inp.task_id) : null;
        if (id != null) {
          const ex = taskMap.get(id) || { id, content: id };
          taskMap.set(id, { id: ex.id, content: ex.content, status: inp.status || ex.status || 'pending' });
        }
      }
    }
  }
  for (const [tid, rec] of provisional) {
    const key = String(resultIds.get(tid) || tid);
    const ex = taskMap.get(key);
    if (!ex) taskMap.set(key, { id: key, content: rec.content, status: rec.status });
    else if (!ex.content || ex.content === key) taskMap.set(key, { id: key, content: rec.content, status: ex.status });
  }
  const open = [];
  for (const task of taskMap.values()) {
    const s = (task.status || '').toLowerCase();
    if (s === 'pending' || s === 'in_progress' || s === 'in-progress') open.push(task);
  }
  return { open };
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

function oneLine(s, max) {
  if (typeof s !== 'string') return '';
  let o = s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (o.length > max) o = o.slice(0, max).trimEnd() + '…';
  return o;
}

try {
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { payload = {}; }

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  let skipped = false;
  try { skipped = require('./skip-guard.js').isSkipped('task-tracker'); } catch (_) { skipped = false; }

  let text;
  if (skipped) {
    text = '';
  } else {
    text = pickMessage(payload);
    // Append a SHORT freshness note ONLY when open/stale tasks exist (keeps the
    // per-turn baseline lean when there is nothing to nudge about).
    const note = freshnessNote(payload);
    if (note) text = text + ' ' + note;
  }

  // Official schema: `hookEventName` is NESTED in `hookSpecificOutput`, not a
  // top-level sibling. KB §1.4 specifies `hookSpecificOutput.additionalContext`
  // for UserPromptSubmit; nesting here is correct per the harness contract.
  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
} catch (_) {
  // Fail-open.
}
process.exit(0);
