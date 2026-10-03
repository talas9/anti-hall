'use strict';
// jev-review-reminder.js (SessionStart) — durable shadow-review nudge.
// Injects ONE line when a shadow-mode integration's review is due; silent
// otherwise (Jev off, reviewReminder off, subagent payload, nothing due).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'jev-review-reminder.js';

function sessionStartPayload(extra) {
  return Object.assign({ hook_event_name: 'SessionStart', session_id: 's1', cwd: process.cwd(), source: 'startup' }, extra || {});
}

function writeJevConfig(home, cfg) {
  const dir = path.join(home, '.anti-hall');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'jev.json'), JSON.stringify(cfg));
}

function writeDecisionRows(home, id, n, ageDays) {
  const dir = path.join(home, '.anti-hall', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date(Date.now() - ageDays * 86400000).toISOString();
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({
      ts, id, h: id + '-h' + i, base: true, jev: true, conf: 0.9, ms: 10,
      backend: 'jev', final: true, changed: null, cached: false, mode: 'shadow',
    }));
  }
  fs.writeFileSync(path.join(dir, 'jev-assist.ndjson'), lines.join('\n') + '\n');
}

test('injects a JEV REVIEW DUE line when an integration is due', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 40, 10);
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(r.json, 'expected JSON output: ' + r.stdout);
    assert.match(r.json.hookSpecificOutput.additionalContext, /JEV REVIEW DUE/);
    assert.match(r.json.hookSpecificOutput.additionalContext, /modelRouting/);
  } finally {
    h.cleanup();
  }
});

test('silent when nothing is due', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 5, 1); // too few / too fresh
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  } finally {
    h.cleanup();
  }
});

test('no review line when Jev is not enabled (only the recommend notice, from jev-recommend.js)', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: false, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 40, 10);
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    const ctx = r.json.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /JEV REVIEW DUE/);
    assert.match(ctx, /Recommended: enable Jev/);
  } finally {
    h.cleanup();
  }
});

test('silent when jev.reviewReminder is explicitly off', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 40, 10);
    // reviewReminder is a settings.js key (env > settings.json > default) --
    // set it via settings.json directly.
    fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'), JSON.stringify({ jev: { reviewReminder: false } }));
    const r = testHook(HOOK, sessionStartPayload(), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  } finally {
    h.cleanup();
  }
});

test('injection appears only in the main session, never a subagent/sidechain payload', () => {
  const h = makeHome();
  try {
    writeJevConfig(h.home, { enabled: true, integrations: { modelRouting: 'shadow' } });
    writeDecisionRows(h.home, 'modelRouting', 40, 10);

    const subagent = testHook(HOOK, sessionStartPayload({ agent_id: 'a1' }), { home: h.home });
    assert.strictEqual(subagent.status, 0);
    assert.strictEqual(subagent.stdout.trim(), '', 'agent_id payload must produce no output');

    const sidechain = testHook(HOOK, sessionStartPayload({ isSidechain: true }), { home: h.home });
    assert.strictEqual(sidechain.status, 0);
    assert.strictEqual(sidechain.stdout.trim(), '', 'isSidechain payload must produce no output');

    const main = testHook(HOOK, sessionStartPayload(), { home: h.home, expectJson: true });
    assert.ok(main.json, 'main-session payload must still produce a line: ' + main.stdout);
  } finally {
    h.cleanup();
  }
});

test('the injected line fits a reasonable size budget even with many due integrations', () => {
  const h = makeHome();
  try {
    const integrations = {};
    for (let i = 0; i < 10; i++) integrations['shadowIntegration' + i] = 'shadow';
    writeJevConfig(h.home, { enabled: true, integrations });
    // Give every one of the 10 integrations enough aged, high-volume rows to
    // qualify as due.
    const dir = path.join(h.home, '.anti-hall', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date(Date.now() - 20 * 86400000).toISOString();
    const lines = [];
    for (let i = 0; i < 10; i++) {
      const id = 'shadowIntegration' + i;
      for (let j = 0; j < 40; j++) {
        lines.push(JSON.stringify({ ts, id, h: id + '-h' + j, base: true, jev: true, conf: 0.9, ms: 10, backend: 'jev', final: true, changed: null, cached: false, mode: 'shadow' }));
      }
    }
    fs.writeFileSync(path.join(dir, 'jev-assist.ndjson'), lines.join('\n') + '\n');

    const r = testHook(HOOK, sessionStartPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(r.json, 'expected JSON output: ' + r.stdout);
    const line = r.json.hookSpecificOutput.additionalContext;
    assert.ok(line.length <= 320, `injected line must stay within budget, got ${line.length} chars: ${line}`);
  } finally {
    h.cleanup();
  }
});
