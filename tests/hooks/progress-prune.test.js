'use strict';
// progress-prune.js (SessionStart hook) — archives stale per-session progress
// files into matching history files, then deletes only after successful append.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'progress-prune.js';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function payload(cwd) {
  return { hook_event_name: 'SessionStart', session_id: 't', cwd };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function writeProgress(cwd, date, session, content, mtimeMs) {
  const p = path.join(cwd, '.anti-hall', 'progress', date, session + '.md');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  if (mtimeMs != null) {
    const sec = mtimeMs / 1000;
    fs.utimesSync(p, sec, sec);
  }
  return p;
}

function historyPath(cwd, date, session) {
  return path.join(cwd, '.anti-hall', 'history', date, session + '.md');
}

function makeProject(h, name = 'project') {
  const cwd = path.join(h.home, name);
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

test('archives and deletes old progress files from past-date folders', () => {
  const h = makeHome();
  try {
    const cwd = makeProject(h);
    const date = '2000-01-02';
    const session = 'sess-old';
    const original = '# progress\n- done: old work\n';
    const progressFile = writeProgress(cwd, date, session, original, Date.now() - 7 * HOUR_MS);

    const r = testHook(HOOK, payload(cwd), { home: h.home });
    assert.strictEqual(r.status, 0, `exit 0; stderr: ${r.stderr}`);
    assert.ok(!fs.existsSync(progressFile), 'old progress file should be deleted after archive append');

    const history = fs.readFileSync(historyPath(cwd, date, session), 'utf8');
    assert.match(history, /## Archived progress \(pruned .*Z\)/);
    assert.match(history, /> # progress/);
    assert.match(history, /> - done: old work/);
  } finally { h.cleanup(); }
});

test('keeps past-date progress files touched inside the 6h safety window', () => {
  const h = makeHome();
  try {
    const cwd = makeProject(h);
    const date = '2000-01-03';
    const session = 'sess-recent';
    const progressFile = writeProgress(cwd, date, session, 'recent\n', Date.now() - HOUR_MS);

    const r = testHook(HOOK, payload(cwd), { home: h.home });
    assert.strictEqual(r.status, 0, `exit 0; stderr: ${r.stderr}`);
    assert.ok(fs.existsSync(progressFile), 'recent progress file should survive');
    assert.ok(!fs.existsSync(historyPath(cwd, date, session)), 'recent progress should not be archived');
  } finally { h.cleanup(); }
});

test('never touches today UTC progress folder even when file mtime is old', () => {
  const h = makeHome();
  try {
    const cwd = makeProject(h);
    const date = todayUtc();
    const session = 'sess-today';
    const progressFile = writeProgress(cwd, date, session, 'today\n', Date.now() - 2 * DAY_MS);

    const r = testHook(HOOK, payload(cwd), { home: h.home });
    assert.strictEqual(r.status, 0, `exit 0; stderr: ${r.stderr}`);
    assert.ok(fs.existsSync(progressFile), 'today progress file should survive regardless of mtime');
    assert.ok(!fs.existsSync(historyPath(cwd, date, session)), 'today progress should not be archived');
  } finally { h.cleanup(); }
});

test('throttles pruning per cwd for 24h', () => {
  const h = makeHome();
  try {
    const cwd = makeProject(h);
    const date = '2000-01-04';
    const first = writeProgress(cwd, date, 'sess-first', 'first\n', Date.now() - 7 * HOUR_MS);

    const r1 = testHook(HOOK, payload(cwd), { home: h.home });
    assert.strictEqual(r1.status, 0, `exit 0; stderr: ${r1.stderr}`);
    assert.ok(!fs.existsSync(first), 'first stale file should be pruned');

    const second = writeProgress(cwd, date, 'sess-second', 'second\n', Date.now() - 7 * HOUR_MS);
    const r2 = testHook(HOOK, payload(cwd), { home: h.home });
    assert.strictEqual(r2.status, 0, `exit 0; stderr: ${r2.stderr}`);
    assert.ok(fs.existsSync(second), 'second stale file should survive because cwd throttle is fresh');
    assert.ok(!fs.existsSync(historyPath(cwd, date, 'sess-second')), 'throttled run should not archive');
  } finally { h.cleanup(); }
});

test('fail-open on malformed marker and missing progress directory', () => {
  const h = makeHome();
  try {
    const cwd = makeProject(h);
    h.writeState('progress-prune-state.json', '{bad json!!');

    const r = testHook(HOOK, payload(cwd), { home: h.home });
    assert.strictEqual(r.status, 0, `exit 0; stderr: ${r.stderr}`);
    assert.strictEqual(r.stdout, '');
  } finally { h.cleanup(); }
});
