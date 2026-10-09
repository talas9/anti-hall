'use strict';
// settings-coordinator-drift-keys.test.js — the 5 coordinator-drift settings
// keys (Phase 2b): type, default, min, env, description rules, validation,
// env override, and the userConfig count staying at 14.
require('../helpers/isolate-home.js');

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const schema = require(path.join(PLUGIN, 'hooks', 'lib', 'settings-schema.js'));
const settings = require(path.join(PLUGIN, 'hooks', 'lib', 'settings.js'));

const NUM = [
  ['coordinatorWorkWindowMinutes', 0, 10, 'ANTIHALL_COORDINATOR_WORK_WINDOW_MINUTES'],
  ['coordinatorWorkNudgeAt', 0, 4, 'ANTIHALL_COORDINATOR_WORK_NUDGE_AT'],
  ['coordinatorWorkBlockAt', 0, 7, 'ANTIHALL_COORDINATOR_WORK_BLOCK_AT'],
  ['coordinatorWorkMaxEntries', 1, 50, 'ANTIHALL_COORDINATOR_WORK_MAX_ENTRIES'],
];

function emptyHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-p2b-'));
}

test('the 4 numeric keys: type number, default, min, env, advanced, no pluginOption', () => {
  for (const [key, min, dflt, env] of NUM) {
    const e = schema.findSetting('guards', key);
    assert.ok(e, key + ' missing from schema');
    assert.strictEqual(e.type, 'number', key);
    assert.strictEqual(e.default, dflt, key);
    assert.strictEqual(e.min, min, key);
    assert.strictEqual(e.env, env, key);
    assert.strictEqual(e.advanced, true, key);
    assert.ok(!('pluginOption' in e), key + ' must not have a pluginOption');
  }
});

test('bashEditParity: boolean, default true, env, advanced, no pluginOption', () => {
  const e = schema.findSetting('guards', 'bashEditParity');
  assert.ok(e, 'bashEditParity missing from schema');
  assert.strictEqual(e.type, 'boolean');
  assert.strictEqual(e.default, true);
  assert.strictEqual(e.env, 'ANTIHALL_BASH_EDIT_PARITY');
  assert.strictEqual(e.advanced, true);
  assert.ok(!('pluginOption' in e));
});

test('descriptions: allowBackgroundScratchScripts mentions the work window; none says "held back"', () => {
  const bg = schema.findSetting('guards', 'allowBackgroundScratchScripts');
  assert.ok(bg.description.includes('work window'), 'allowBackgroundScratchScripts description lacks "work window"');
  for (const key of NUM.map((n) => n[0]).concat('bashEditParity')) {
    assert.ok(!schema.findSetting('guards', key).description.includes('held back'), key);
  }
  const all = schema.allSettings();
  for (const s of all) assert.ok(!/held back/.test(s.description || ''), s.key + ' description says "held back"');
});

test('coordinatorWorkWindowMinutes description matches the final rules (non-git: only coordinator-writable or fresh scripts)', () => {
  const d = schema.findSetting('guards', 'coordinatorWorkWindowMinutes').description;
  assert.ok(/non-git/.test(d), 'must state the non-git rule');
  assert.ok(/old/i.test(d) && /fresh/i.test(d) || /coordinator-writable/.test(d), 'non-git rule must name fresh/coordinator-writable');
});

test('defaults resolve from an empty home', () => {
  const home = emptyHome();
  const opts = { home, env: {} };
  for (const [key, , dflt] of NUM) assert.strictEqual(settings.get('guards', key, undefined, opts), dflt, key);
  assert.strictEqual(settings.get('guards', 'bashEditParity', undefined, opts), true);
});

test('env 0 turns the numeric keys off; env off turns bashEditParity off', () => {
  const home = emptyHome();
  for (const [key, min, , env] of NUM) {
    if (min !== 0) continue;
    assert.strictEqual(settings.get('guards', key, undefined, { home, env: { [env]: '0' } }), 0, key);
  }
  assert.strictEqual(settings.get('guards', 'bashEditParity', undefined, { home, env: { ANTIHALL_BASH_EDIT_PARITY: 'off' } }), false);
});

test('negative values and maxEntries 0 are rejected by set()', () => {
  const home = emptyHome();
  for (const [key] of NUM) {
    const r = settings.set('guards', key, -1, { home, env: {} });
    assert.strictEqual(r.ok, false, key + ' accepted -1');
  }
  assert.strictEqual(settings.set('guards', 'coordinatorWorkMaxEntries', 0, { home, env: {} }).ok, false);
  assert.strictEqual(settings.set('guards', 'coordinatorWorkWindowMinutes', 0, { home, env: {} }).ok, true);
  assert.strictEqual(settings.set('guards', 'coordinatorWorkMaxEntries', 1, { home, env: {} }).ok, true);
});

test('plugin.json userConfig stays at 14 entries', () => {
  const uc = require(path.join(PLUGIN, '.claude-plugin', 'plugin.json')).userConfig || {};
  assert.strictEqual(Object.keys(uc).length, 14);
});

test('a negative env value for the 4 numeric keys falls back to the default, not 0', () => {
  const home = emptyHome();
  for (const [key, , dflt, env] of NUM) {
    assert.strictEqual(settings.get('guards', key, undefined, { home, env: { [env]: '-3' } }), dflt, key);
  }
  const L = require(path.join(PLUGIN, 'hooks', 'lib', 'coordinator-work.js'));
  const saved = {};
  for (const [, , , env] of NUM) { saved[env] = process.env[env]; process.env[env] = '-1'; }
  try {
    assert.deepStrictEqual(L.config(), { tMs: 600000, nudgeAt: 4, blockAt: 7, cap: 50 });
  } finally {
    for (const [env, v] of Object.entries(saved)) { if (v === undefined) delete process.env[env]; else process.env[env] = v; }
  }
});
