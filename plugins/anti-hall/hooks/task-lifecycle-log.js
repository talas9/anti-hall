#!/usr/bin/env node
// anti-hall :: task-lifecycle-log (TaskCreated + TaskCompleted, no matcher)
//
// LOG-ONLY (spec decision: no evidence gate, no agent hook, no PreCompact
// snapshot). Appends one line per TaskCreated/TaskCompleted event to the
// per-session history ledger `.anti-hall/history/<date>/<session>.md`, and
// registers that file in `.anti-hall/history/<date>/INDEX.md` via the same
// idempotent helper tasklist-guard.js already uses.
//
// Contract (Claude Code TaskCreated / TaskCompleted hooks — no matcher support):
//   stdin  : JSON { session_id, transcript_path, cwd, task_id, task_subject,
//                   task_description?, teammate_name?, hook_event_name }
//   stdout : nothing — never injected into context, never a blocking decision.
//   exit 0 : ALWAYS — fail-open on any error (malformed stdin, unwritable cwd,
//            etc.); this hook must never block or slow down task lifecycle.
// Pure Node built-ins. Target: <50ms (single small read + single append).

'use strict';

const fs = require('fs');
const path = require('path');
const { appendIndexLineIfAbsent } = require('./session-history-index.js');
// repoRoot(cwd) -- the canonical resolver, so a cwd already inside
// .anti-hall/**/... does not double onto itself (2026-09-25 fix; see
// hooks/lib/handover-find.js for the full rationale).
const { repoRoot } = require('./lib/handover-find.js');

const UNKNOWN_SESSION = 'unknown-session';

function sanitizeSessionId(raw) {
  const safe = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe || UNKNOWN_SESSION;
}

// sanitizeText — single line, no control chars, bounded length so a task
// subject/description can't inject newlines or blow up the ledger line.
function sanitizeText(s, maxLen) {
  if (typeof s !== 'string') return '';
  const out = s.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim();
  return out.length > maxLen ? out.slice(0, maxLen) + '…' : out;
}

function main() {
  // Settings switch maintenance.taskLifecycleLog (0.108.4): off -> no-op. Fail-open: any error runs the hook.
  try { if (!require('./lib/settings.js').enabled('maintenance', 'taskLifecycleLog')) return; } catch (_) { /* run */ }
  let payload = null;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0); // malformed/absent stdin -> no write, fail-open
  }
  if (!payload || typeof payload !== 'object') process.exit(0);

  const eventName = payload.hook_event_name;
  if (eventName !== 'TaskCreated' && eventName !== 'TaskCompleted') process.exit(0);

  const cwd = payload.cwd;
  if (!cwd || typeof cwd !== 'string') process.exit(0);

  const taskId = sanitizeText(
    payload.task_id != null ? String(payload.task_id) : '', 200
  );
  if (!taskId) process.exit(0);

  const rawSessionId = payload.session_id != null ? String(payload.session_id) : '';
  const sessionIdForPath = sanitizeSessionId(rawSessionId);
  const date = new Date().toISOString().slice(0, 10);
  const subject = sanitizeText(payload.task_subject || '', 200);
  const teammate = sanitizeText(payload.teammate_name || '', 100);

  const kindLabel = eventName === 'TaskCreated' ? 'TaskCreated' : 'TaskCompleted';
  let line = '- ' + new Date().toISOString() + ' · ' + kindLabel + ' · task_id=' + taskId;
  if (teammate) line += ' · teammate=' + teammate;
  if (subject) line += ' · ' + subject;

  try {
    const root = repoRoot(cwd);
    const historyDir = path.join(root, '.anti-hall', 'history', date);
    fs.mkdirSync(historyDir, { recursive: true });
    const ledgerPath = path.join(historyDir, sessionIdForPath + '.md');
    fs.appendFileSync(ledgerPath, line + '\n', { flag: 'a' });

    // Same INDEX.md location + relative-link shape tasklist-guard.js's own
    // maintainSessionIndex() uses for kind='history' (.anti-hall/history/INDEX.md).
    const indexPath = path.join(root, '.anti-hall', 'history', 'INDEX.md');
    const indexLine = '- ' + date + ' · ' + sessionIdForPath + ' · [history](../' +
      date + '/' + sessionIdForPath + '.md)';
    appendIndexLineIfAbsent(indexPath, sessionIdForPath, indexLine);
  } catch (_) {
    // fail-open: ledger maintenance is advisory, never blocks task lifecycle.
  }

  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
