'use strict';
// jev-weekly-scorecard (SessionStart). A once-a-week, ADVISORY-ONLY nudge
// pointing at /anti-hall:jev when the last 7 days of jev-assist.ndjson show an
// integration has earned a KEEP or REMOVE verdict that jev.json's mode has not
// been promoted/demoted to match yet. Never changes any mode itself.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'jev-weekly-scorecard.js';

function sessionStartPayload(sessionId, cwd) {
  return { hook_event_name: 'SessionStart', session_id: sessionId || 's1', cwd: cwd || process.cwd(), source: 'startup' };
}

function writeJevConfig(home, cfg) {
  const dir = path.join(home, '.anti-hall');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'jev.json'), JSON.stringify(cfg));
}

function writeLatch(home, lastCheckedTs) {
  const dir = path.join(home, '.anti-hall', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'jev-weekly-notice.json'), JSON.stringify({ lastCheckedTs }));
}

// writeKeepWorthyLog(home, id) -- >=50 calls, all changed, all good-outcome ->
// a real KEEP verdict per buildReport's own thresholds.
function writeKeepWorthyLog(home, id) {
  const dir = path.join(home, '.anti-hall', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < 60; i++) {
    const h = 'h' + i;
    lines.push(JSON.stringify({
      ts: new Date().toISOString(), id, h, base: false, jev: true, conf: 0.95,
      ms: 100, backend: 'jev', final: true, changed: 'added', cached: false, mode: 'on',
    }));
    lines.push(JSON.stringify({ type: 'outcome', id, h, outcome: 'evidence-added' }));
  }
  fs.writeFileSync(path.join(dir, 'jev-assist.ndjson'), lines.join('\n') + '\n');
}

// writeRemoveWorthyLog(home, id) -- >=200 calls, a labelled sample (>=20
// tp+fp) with good-outcome rate <60% -> REMOVE. (v0.108.1: changedRate<1%
// alone no longer triggers REMOVE, and REMOVE now requires a labelled sample
// -- see jev-report.js's fix note -- so this fixture carries 25 changed
// decisions with real, labelled outcomes: 10 good, 15 bad = 40% good-outcome.)
function writeRemoveWorthyLog(home, id) {
  const dir = path.join(home, '.anti-hall', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < 220; i++) {
    const changed = i < 25;
    lines.push(JSON.stringify({
      ts: new Date().toISOString(), id, h: 'h' + i, base: false, jev: changed, conf: 0.95,
      ms: 100, backend: 'jev', final: changed, changed: changed ? 'added' : null, cached: false, mode: 'on',
    }));
  }
  for (let i = 0; i < 10; i++) lines.push(JSON.stringify({ type: 'outcome', id, h: 'h' + i, outcome: 'evidence-added' }));
  for (let i = 10; i < 25; i++) lines.push(JSON.stringify({ type: 'outcome', id, h: 'h' + i, outcome: 'user-override' }));
  fs.writeFileSync(path.join(dir, 'jev-assist.ndjson'), lines.join('\n') + '\n');
}

function readLatch(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.anti-hall', 'state', 'jev-weekly-notice.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

test('silent when jev.json is absent (Jev not enabled)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(readLatch(h.home), null, 'must not even check/consume the weekly latch when Jev is off');
  } finally { h.cleanup(); }
});

test('silent when weeklyNotice:false (explicit opt-out)', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, weeklyNotice: false });
    writeKeepWorthyLog(h.home, 'speculation');
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { h.cleanup(); }
});

test('silent for a DevSwarm CHILD workspace session (main-thread-only)', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true });
    writeKeepWorthyLog(h.home, 'speculation');
    const r = testHook(HOOK, sessionStartPayload(), {
      home: h.home,
      env: { DEVSWARM_SOURCE_BRANCH: 'some-branch' },
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { h.cleanup(); }
});

test('silent when the weekly latch was checked within the last 7 days', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true });
    writeKeepWorthyLog(h.home, 'speculation');
    writeLatch(h.home, Date.now() - 24 * 60 * 60 * 1000); // checked 1 day ago
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { h.cleanup(); }
});

test('KEEP verdict + mode not already "on" -> notice fires, latch updated', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { speculation: 'shadow' } });
    writeKeepWorthyLog(h.home, 'speculation');
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(r.json, `expected JSON output; stdout=${r.stdout}`);
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(r.json.hookSpecificOutput.additionalContext, /Jev scorecard: speculation ready to switch ON — run \/anti-hall:jev/);
    const latch = readLatch(h.home);
    assert.ok(latch && Number.isFinite(latch.lastCheckedTs), 'latch must be updated after a check');
  } finally { h.cleanup(); }
});

test('KEEP verdict but mode is ALREADY "on" -> no notice (nothing to switch)', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { speculation: 'on' } });
    writeKeepWorthyLog(h.home, 'speculation');
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.ok(readLatch(h.home), 'the check still ran and consumed the week');
  } finally { h.cleanup(); }
});

test('REMOVE verdict + mode not already "off" -> notice fires with OFF direction', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeRemoveWorthyLog(h.home, 'modelRouting');
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(r.json, `expected JSON output; stdout=${r.stdout}`);
    assert.match(r.json.hookSpecificOutput.additionalContext, /Jev scorecard: modelRouting ready to switch OFF — run \/anti-hall:jev/);
  } finally { h.cleanup(); }
});

test('no qualifying integration (not enough data) -> silent, but latch still updated (once-a-week cadence holds regardless of outcome)', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true });
    const dir = path.join(h.home, '.anti-hall', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'jev-assist.ndjson'), JSON.stringify({
      ts: new Date().toISOString(), id: 'speculation', h: 'h1', base: false, jev: true,
      conf: 0.9, ms: 50, backend: 'jev', final: false, changed: null, cached: false, mode: 'shadow',
    }) + '\n');
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.ok(readLatch(h.home), 'latch consumed even with nothing to announce');
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed jev.json -> silent, exit 0, never throws', () => {
  const h = makeHome();
  try {
    const dir = path.join(h.home, '.anti-hall');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'jev.json'), '{not json');
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: empty stdin -> silent, exit 0', () => {
  const h = makeHome();
  try {
    const { testHookRaw } = require('../helpers/spawn-hook.js');
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { h.cleanup(); }
});
