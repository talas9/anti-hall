'use strict';
// fable-availability.js (SessionStart hook) — reads fake HOME ~/.claude.json,
// writes ~/.anti-hall/fable-availability.json, and emits context only when true.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'fable-availability.js';
const PAYLOAD = { hook_event_name: 'SessionStart', session_id: 't' };

function writeClaudeJson(h, obj) {
  fs.writeFileSync(path.join(h.home, '.claude.json'), JSON.stringify(obj), 'utf8');
}

function readState(h) {
  return JSON.parse(fs.readFileSync(path.join(h.antiHall, 'fable-availability.json'), 'utf8'));
}

function hasContext(r) {
  return (
    r.json &&
    r.json.hookSpecificOutput &&
    typeof r.json.hookSpecificOutput.additionalContext === 'string' &&
    r.json.hookSpecificOutput.additionalContext.length > 0
  );
}

test('modelAccessCache entitled:true fable entry => available:true and additionalContext', () => {
  const h = makeHome();
  try {
    writeClaudeJson(h, {
      modelAccessCache: [{ apiName: 'claude-fable-5', entitled: true, maxEffortLevel: 'xhigh' }],
      additionalModelOptionsCache: [],
    });
    const r = testHook(HOOK, PAYLOAD, { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, `exit 0; stderr: ${r.stderr}`);
    assert.ok(hasContext(r), `expected additionalContext; stdout: ${r.stdout}`);
    assert.match(r.json.hookSpecificOutput.additionalContext, /Fable 5 is available/);
    const state = readState(h);
    assert.strictEqual(state.available, true);
    assert.strictEqual(state.source, 'modelAccessCache');
    assert.strictEqual(typeof state.checkedAt, 'number');
  } finally { h.cleanup(); }
});

test('modelAccessCache entitled:false fable entry => available:false and silent', () => {
  const h = makeHome();
  try {
    writeClaudeJson(h, {
      modelAccessCache: [{ apiName: 'fable[1m]', entitled: false }],
      additionalModelOptionsCache: [],
    });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should be silent; stdout: ${r.stdout}`);
    const state = readState(h);
    assert.strictEqual(state.available, false);
    assert.strictEqual(state.source, 'modelAccessCache');
  } finally { h.cleanup(); }
});

test('additionalModelOptionsCache disabled:true fable entry => available:false', () => {
  const h = makeHome();
  try {
    writeClaudeJson(h, {
      modelAccessCache: [],
      additionalModelOptionsCache: [{ value: 'fable', label: 'Fable 5', disabled: true }],
    });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should be silent; stdout: ${r.stdout}`);
    const state = readState(h);
    assert.strictEqual(state.available, false);
    assert.strictEqual(state.source, 'additionalModelOptionsCache');
  } finally { h.cleanup(); }
});

test('empty caches with no fable entry => available:null unknown and silent', () => {
  const h = makeHome();
  try {
    writeClaudeJson(h, { modelAccessCache: [], additionalModelOptionsCache: [] });
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should be silent; stdout: ${r.stdout}`);
    const state = readState(h);
    assert.strictEqual(state.available, null);
    assert.strictEqual(state.source, 'unknown');
  } finally { h.cleanup(); }
});

test('missing ~/.claude.json => fail-open, available:null, no crash', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should be silent; stdout: ${r.stdout}`);
    const state = readState(h);
    assert.strictEqual(state.available, null);
    assert.strictEqual(state.source, 'unknown');
  } finally { h.cleanup(); }
});

test('malformed ~/.claude.json => fail-open, available:null, no crash', () => {
  const h = makeHome();
  try {
    fs.writeFileSync(path.join(h.home, '.claude.json'), '{bad json!!', 'utf8');
    const r = testHook(HOOK, PAYLOAD, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!hasContext(r), `should be silent; stdout: ${r.stdout}`);
    const state = readState(h);
    assert.strictEqual(state.available, null);
    assert.strictEqual(state.source, 'unknown');
  } finally { h.cleanup(); }
});
