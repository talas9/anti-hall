'use strict';
// task-lifecycle-log.js — TaskCreated/TaskCompleted append one line each to the
// per-session `.anti-hall/history/<date>/<session>.md` ledger. Log-only: never
// blocks, never prints JSON that could be read as a blocking decision, fail-open
// on malformed input. Uses an isolated fake cwd (project tree writes) AND an
// isolated fake HOME (defensive — the hook itself never touches HOME).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function ledgerPath(cwd, sessionId) {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(cwd, '.anti-hall', 'history', date, sessionId + '.md');
}
function indexPath(cwd) {
  return path.join(cwd, '.anti-hall', 'history', 'INDEX.md');
}

test('TaskCreated appends one line to the per-session ledger and exits 0', () => {
  const cwd = tmpDir('antihall-tlog-created-');
  const home = tmpDir('antihall-tlog-home-');
  try {
    const payload = {
      hook_event_name: 'TaskCreated',
      session_id: 'sessA',
      cwd,
      task_id: 'task-1',
      task_subject: 'Do the thing',
    };
    const r = testHook('task-lifecycle-log.js', payload, { home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    const lp = ledgerPath(cwd, 'sessA');
    assert.ok(fs.existsSync(lp), 'ledger file should exist');
    const content = fs.readFileSync(lp, 'utf8');
    assert.match(content, /TaskCreated/);
    assert.match(content, /task_id=task-1/);
    assert.match(content, /Do the thing/);
    assert.strictEqual(content.trim().split('\n').length, 1);
    assert.ok(fs.existsSync(indexPath(cwd)), 'INDEX.md should be maintained');
  } finally { rm(cwd); rm(home); }
});

test('TaskCompleted appends a line distinct from TaskCreated, both accumulate', () => {
  const cwd = tmpDir('antihall-tlog-completed-');
  const home = tmpDir('antihall-tlog-home-');
  try {
    const base = { session_id: 'sessB', cwd, task_id: 'task-2', task_subject: 'Ship it' };
    const r1 = testHook('task-lifecycle-log.js', { hook_event_name: 'TaskCreated', ...base }, { home });
    const r2 = testHook('task-lifecycle-log.js', { hook_event_name: 'TaskCompleted', ...base }, { home });
    assert.strictEqual(r1.status, 0);
    assert.strictEqual(r2.status, 0);
    const content = fs.readFileSync(ledgerPath(cwd, 'sessB'), 'utf8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 2);
    assert.match(lines[0], /TaskCreated/);
    assert.match(lines[1], /TaskCompleted/);
  } finally { rm(cwd); rm(home); }
});

test('malformed stdin: exit 0, no write, nothing on stdout', () => {
  const cwd = tmpDir('antihall-tlog-malformed-');
  const home = tmpDir('antihall-tlog-home-');
  try {
    const r = testHookRaw('task-lifecycle-log.js', '{not json', { home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.ok(!fs.existsSync(path.join(cwd, '.anti-hall')), 'nothing should be written');
  } finally { rm(cwd); rm(home); }
});

test('empty stdin: exit 0, no write', () => {
  const cwd = tmpDir('antihall-tlog-empty-');
  const home = tmpDir('antihall-tlog-home-');
  try {
    const r = testHookRaw('task-lifecycle-log.js', '', { home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.ok(!fs.existsSync(path.join(cwd, '.anti-hall')));
  } finally { rm(cwd); rm(home); }
});

test('unrelated hook_event_name (e.g. SessionStart) is a no-op, exit 0', () => {
  const cwd = tmpDir('antihall-tlog-unrelated-');
  const home = tmpDir('antihall-tlog-home-');
  try {
    const payload = {
      hook_event_name: 'SessionStart',
      session_id: 'sessC',
      cwd,
      task_id: 'task-3',
    };
    const r = testHook('task-lifecycle-log.js', payload, { home });
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(cwd, '.anti-hall')));
  } finally { rm(cwd); rm(home); }
});

test('missing task_id: exit 0, no write (fail-open)', () => {
  const cwd = tmpDir('antihall-tlog-notaskid-');
  const home = tmpDir('antihall-tlog-home-');
  try {
    const payload = { hook_event_name: 'TaskCreated', session_id: 'sessD', cwd };
    const r = testHook('task-lifecycle-log.js', payload, { home });
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(cwd, '.anti-hall')));
  } finally { rm(cwd); rm(home); }
});

test('never emits stdout JSON that could be read as a blocking decision', () => {
  const cwd = tmpDir('antihall-tlog-nostdout-');
  const home = tmpDir('antihall-tlog-home-');
  try {
    const payload = {
      hook_event_name: 'TaskCompleted', session_id: 'sessE', cwd,
      task_id: 'task-5', task_subject: 'x', teammate_name: 'worker-1',
    };
    const r = testHook('task-lifecycle-log.js', payload, { home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  } finally { rm(cwd); rm(home); }
});
