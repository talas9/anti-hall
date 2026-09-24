#!/usr/bin/env node
// anti-hall :: precompact-snapshot (PreCompact, manual + auto)
//
// SAFETY NET for the self-written handover. Right before Claude Code (or
// Codex) compacts, write a MECHANICAL snapshot of this session's continuation
// state to
//   <cwd>/.anti-hall/handovers/<YYYY-MM-DD>/<session-id>/PRECOMPACT-<n>.md
// containing:
//   - pwd, git branch/upstream line, HEAD (sha + subject), dirty files;
//   - a task-list snapshot parsed from the transcript tail (TodoWrite, and
//     TaskCreate/TaskUpdate with ids read back from the TaskCreate results);
//   - the last MAX_USER_MESSAGES user messages VERBATIM (compaction keeps
//     user-issued session rules worst of all — docs/KB-handover-research.md);
//   - a pointer to the newest HANDOVER*.md, if any.
// hooks/handover-resume.js names the snapshot on the next SessionStart.
//
// WHY MECHANICAL: a PreCompact hook cannot make the model act (it runs a
// command, no model turn), so this is a crash dump, not a handover — no
// judgment, no summaries.
//
// NEVER BLOCKS COMPACTION. Official Claude Code hooks reference
// (https://code.claude.com/docs/en/hooks, "PreCompact", fetched 2026-09-24):
// PreCompact CAN block — exit code 2, or JSON `"decision": "block"` — and a
// blocked auto-compact that was recovering from a context-limit error fails
// the request. Codex (https://learn.chatgpt.com/docs/hooks, "PreCompact"):
// JSON `continue: false` stops before compacting; plain stdout is ignored.
// So this hook ALWAYS exits 0 and writes NOTHING to stdout — on any error it
// just skips the snapshot. Claude Code also discards a timed-out hook's
// output (hooks reference, "Timeouts"), so a slow git call cannot block
// either; the git calls carry their own short timeouts anyway.
//
// Contract:
//   stdin  : JSON { session_id, transcript_path, cwd, hook_event_name,
//            trigger: 'manual'|'auto', custom_instructions (Claude) }
//   stdout : nothing, ever
//   exit 0 : always
//
// Escape hatch: skip-guard.js isSkipped('precompact-snapshot').
// Pure Node built-ins only.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isSubagentByPayload } = require('./coordinator-detect.js');
const { isSkipped } = require('./skip-guard.js');
const { readTail } = require('./lib/transcript-tail.js');
const find = require('./lib/handover-find.js');

const MAX_USER_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 4000;
const MAX_DIRTY_LISTED = 50;
const GIT_TIMEOUT_MS = 2000;

// Harness-injected "user" entries that are not something the user typed.
const NOT_TYPED_RE = /^<(task-notification|local-command-|system-reminder|bash-std(out|err)|command-(name|message|args))/;

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_) {
    return null;
  }
}

// gitState(cwd) -> { branchLine, head, dirty: string[] } | null (not a repo)
function gitState(cwd) {
  const status = git(cwd, ['status', '--porcelain=v1', '--branch']);
  if (status === null) return null;
  const lines = status.split('\n').filter(Boolean);
  const branchLine = lines[0] && lines[0].startsWith('## ') ? lines[0].slice(3) : '(unknown)';
  const dirty = lines.filter((l) => !l.startsWith('## '));
  const head = (git(cwd, ['log', '-1', '--format=%h %s']) || '').trim() || '(no commits)';
  return { branchLine, head, dirty };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  if (content.some((c) => c && c.type === 'tool_result')) return '';
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
}

// userMessages(lines) -> last MAX_USER_MESSAGES typed user messages, oldest
// first. Claude transcript: { type:'user', message:{ content } } minus meta /
// sidechain / compact-summary / tool results / harness tags. Codex rollout:
// { type:'event_msg', payload:{ type:'user_message', message } } (the
// response_item copies also carry AGENTS.md injections, so they're skipped).
function userMessages(lines) {
  const out = [];
  for (const line of lines || []) {
    if (!line || (line.indexOf('"user"') === -1 && line.indexOf('user_message') === -1)) continue;
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (!e || typeof e !== 'object') continue;
    let text = '';
    if (e.type === 'user' && !e.isMeta && !e.isSidechain && !e.isCompactSummary && e.message) {
      text = textOf(e.message.content);
    } else if (e.type === 'event_msg' && e.payload && e.payload.type === 'user_message' && typeof e.payload.message === 'string') {
      text = e.payload.message;
    }
    text = String(text || '').trim();
    if (!text || NOT_TYPED_RE.test(text)) continue;
    out.push({ ts: typeof e.timestamp === 'string' ? e.timestamp : '', text });
  }
  return out.slice(-MAX_USER_MESSAGES);
}

// taskSnapshot(lines) -> [{ id, subject, status }] | null (nothing tracked).
// TodoWrite replaces the whole list; TaskCreate's harness id is read back from
// its tool_result ("Task #<n> created successfully: <subject>"); TaskUpdate
// sets status by that id.
function taskSnapshot(lines) {
  let todos = null;
  const tasks = new Map(); // id -> { id, subject, status }
  const pendingCreates = new Map(); // tool_use id -> subject
  for (const line of lines || []) {
    if (!line) continue;
    if (line.indexOf('TodoWrite') === -1 && line.indexOf('TaskCreate') === -1 &&
        line.indexOf('TaskUpdate') === -1 && line.indexOf('created successfully') === -1) continue;
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (!e || e.isSidechain === true || !e.message || !Array.isArray(e.message.content)) continue;
    for (const item of e.message.content) {
      if (!item) continue;
      if (e.type === 'assistant' && item.type === 'tool_use') {
        const inp = item.input || {};
        if (item.name === 'TodoWrite' && Array.isArray(inp.todos)) {
          todos = inp.todos.map((t, i) => ({
            id: String(i + 1), subject: String((t && (t.content || t.subject)) || ''), status: (t && t.status) || 'pending',
          }));
        } else if (item.name === 'TaskCreate' && item.id) {
          pendingCreates.set(item.id, String(inp.subject || ''));
        } else if (item.name === 'TaskUpdate') {
          const id = inp.taskId != null ? String(inp.taskId) : inp.id != null ? String(inp.id) : null;
          if (id !== null) {
            const t = tasks.get(id) || { id, subject: '', status: 'pending' };
            if (inp.status) t.status = inp.status;
            if (inp.subject) t.subject = String(inp.subject);
            tasks.set(id, t);
          }
        }
      } else if (e.type === 'user' && item.type === 'tool_result' && pendingCreates.has(item.tool_use_id)) {
        const txt = typeof item.content === 'string' ? item.content : textOf(item.content);
        const m = /Task #(\d+) created successfully/.exec(txt || '');
        if (m) {
          const prior = tasks.get(m[1]);
          tasks.set(m[1], { id: m[1], subject: pendingCreates.get(item.tool_use_id), status: (prior && prior.status) || 'pending' });
        }
        pendingCreates.delete(item.tool_use_id);
      }
    }
  }
  const list = [...(todos || []), ...[...tasks.values()].filter((t) => t.status !== 'deleted')];
  return (todos || tasks.size) ? list : null;
}

function cell(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 200);
}

function buildSnapshot(ctx) {
  const L = [];
  L.push('# PRECOMPACT snapshot — ' + ctx.sessionId + ' · #' + ctx.n + ' · ' + ctx.nowIso);
  L.push('');
  L.push('Mechanical crash dump written by anti-hall\'s PreCompact hook right before compaction (trigger: ' + ctx.trigger +
    '). NOT a handover: no model judgment went into it. Read it with the newest handover; ' +
    'the user messages below are verbatim (they may carry session rules the compact summary dropped).');
  L.push('');
  L.push('## Newest handover');
  L.push(ctx.handover ? ctx.handover.filePath + ' (modified ' + new Date(ctx.handover.mtimeMs).toISOString() + ')'
    : 'none found under .anti-hall/handovers/ — no HANDOVER*.md exists for this repo');
  L.push('');
  L.push('## Repo state');
  L.push('pwd: ' + ctx.cwd);
  if (!ctx.git) {
    L.push('git: not a git repository (or git unavailable)');
  } else {
    L.push('branch: ' + ctx.git.branchLine);
    L.push('HEAD: ' + ctx.git.head);
    L.push('dirty files: ' + ctx.git.dirty.length + (ctx.git.dirty.length ? '' : ' (clean)'));
    for (const d of ctx.git.dirty.slice(0, MAX_DIRTY_LISTED)) L.push('    ' + d);
    if (ctx.git.dirty.length > MAX_DIRTY_LISTED) L.push('    … +' + (ctx.git.dirty.length - MAX_DIRTY_LISTED) + ' more');
  }
  if (ctx.customInstructions) {
    L.push('');
    L.push('## /compact instructions (verbatim)');
    L.push(ctx.customInstructions);
  }
  L.push('');
  L.push('## Task list snapshot (from the transcript)');
  if (!ctx.tasks) {
    L.push('not derivable — no TodoWrite/TaskCreate/TaskUpdate calls in the readable transcript tail');
  } else if (ctx.tasks.length === 0) {
    L.push('empty list');
  } else {
    L.push('| id | subject | status |');
    L.push('|---|---|---|');
    for (const t of ctx.tasks) L.push('| ' + cell(t.id) + ' | ' + cell(t.subject) + ' | ' + cell(t.status) + ' |');
  }
  L.push('');
  L.push('## Last ' + ctx.messages.length + ' user message(s), verbatim, oldest first');
  if (ctx.messages.length === 0) L.push('none found in the readable transcript tail');
  ctx.messages.forEach((m, i) => {
    L.push('');
    L.push('### ' + (i + 1) + (m.ts ? ' · ' + m.ts : ''));
    const body = m.text.length > MAX_MESSAGE_CHARS
      ? m.text.slice(0, MAX_MESSAGE_CHARS) + '\n[… truncated ' + (m.text.length - MAX_MESSAGE_CHARS) + ' chars]'
      : m.text;
    L.push('````text');
    L.push(body);
    L.push('````');
  });
  L.push('');
  return L.join('\n');
}

function main() {
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { payload = null; }
  if (!payload || typeof payload !== 'object') return;
  if (isSubagentByPayload(payload) || isSkipped('precompact-snapshot')) return;
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
  if (!cwd) return;

  const sessionId = find.sanitizeSessionId(payload.session_id);
  const root = find.handoversRoot(cwd);
  const dir = path.join(root, find.localDate(), sessionId);

  const lines = typeof payload.transcript_path === 'string' ? readTail(payload.transcript_path) : null;
  const handover = find.findNewestHandover(root, sessionId);

  fs.mkdirSync(dir, { recursive: true });
  let n = 1;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = find.PRECOMPACT_FILE_RE.exec(f);
      if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
    }
  } catch (_) { /* n stays 1 */ }

  const body = buildSnapshot({
    sessionId, n, cwd,
    nowIso: new Date().toISOString(),
    trigger: payload.trigger === 'manual' || payload.trigger === 'auto' ? payload.trigger : 'unknown-trigger',
    customInstructions: typeof payload.custom_instructions === 'string' && payload.custom_instructions.trim()
      ? payload.custom_instructions.trim() : '',
    handover,
    git: gitState(cwd),
    tasks: taskSnapshot(lines),
    messages: userMessages(lines),
  });
  // 'wx': never overwrite an existing snapshot (a concurrent run just skips).
  fs.writeFileSync(path.join(dir, 'PRECOMPACT-' + n + '.md'), body, { encoding: 'utf8', flag: 'wx' });
}

if (require.main === module) {
  try {
    main();
  } catch (_) {
    /* fail-open: never block compaction */
  }
  process.exit(0);
}

module.exports = { userMessages, taskSnapshot, buildSnapshot };
