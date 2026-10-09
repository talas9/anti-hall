'use strict';
// runLegacyKeyOptInMigration — one-time carry-over of the Jev key-file opt-in
// for installs that already have Jev on + a key file. Isolated tmp HOME only.
// Never enables the Anthropic flag, never reads/copies the key, never overrides
// a user's own value, fail-open on a corrupt settings.json, stamped once.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeHome } = require('../helpers/fixtures.js');
const M = require('../../plugins/anti-hall/companion/lib/migrations.js');
const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');

const SECRET = 'sk-' + 'key-file-secret-value';
function putKeyFile(home, rel, body) {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
  return p;
}
const KEY_REL = path.join('.config', 'vercel', 'ai-gateway-key');
const settingsFile = (home) => path.join(home, '.anti-hall', 'settings.json');
const readSettings = (home) => JSON.parse(fs.readFileSync(settingsFile(home), 'utf8'));

test('Jev enabled + key file present -> opt-in set once, explicit notice, key never read/copied', () => {
  const h = makeHome();
  try {
    h.writeState('settings.json', { jev: { enabled: true }, guards: { stashGuard: true } });
    putKeyFile(h.home, KEY_REL, SECRET + '\n');
    const r = M.runLegacyKeyOptInMigration(h.home, {});
    assert.strictEqual(r.status, 'fixed');
    assert.match(r.msg, /ENABLED jev\.allowLegacyKeyRead/);
    assert.match(r.msg, /To turn it off/);
    assert.doesNotMatch(r.msg, new RegExp(SECRET));
    const after = readSettings(h.home);
    assert.strictEqual(after.jev.allowLegacyKeyRead, true);
    assert.strictEqual(after.jev.enabled, true, 'other settings untouched');
    assert.strictEqual(after.guards.stashGuard, true);
    assert.strictEqual(after.guards.allowAnthropicEnvKey, undefined, 'never enables the Anthropic flag');
    assert.doesNotMatch(fs.readFileSync(settingsFile(h.home), 'utf8'), new RegExp(SECRET));
  } finally { h.cleanup(); }
});

test('legacy jev.json enabled counts as "Jev enabled"; a custom jev.keyFile is the file checked', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, keyFile: path.join(h.home, 'custom-key') });
    putKeyFile(h.home, 'custom-key', SECRET);
    const r = M.runLegacyKeyOptInMigration(h.home, {});
    assert.strictEqual(r.status, 'fixed');
    assert.strictEqual(readSettings(h.home).jev.allowLegacyKeyRead, true);
  } finally { h.cleanup(); }
});

test('Jev not enabled, or no/empty key file -> nothing enabled (but stamped)', () => {
  for (const seed of [
    (h) => { h.writeState('settings.json', { jev: { enabled: false } }); putKeyFile(h.home, KEY_REL, SECRET); },
    (h) => { h.writeState('settings.json', { jev: { enabled: true } }); },
    (h) => { h.writeState('settings.json', { jev: { enabled: true } }); putKeyFile(h.home, KEY_REL, ''); },
  ]) {
    const h = makeHome();
    try {
      seed(h);
      const r = M.runLegacyKeyOptInMigration(h.home, {});
      assert.strictEqual(r.status, 'skipped');
      assert.strictEqual(readSettings(h.home).jev.allowLegacyKeyRead, undefined);
    } finally { h.cleanup(); }
  }
});

test('idempotent + one-time: a second run is a marker skip, and a user reset is not undone', () => {
  const h = makeHome();
  try {
    h.writeState('settings.json', { jev: { enabled: true } });
    putKeyFile(h.home, KEY_REL, SECRET);
    assert.strictEqual(M.runLegacyKeyOptInMigration(h.home, {}).status, 'fixed');
    settings.reset('jev', 'allowLegacyKeyRead', { home: h.home });
    assert.strictEqual(readSettings(h.home).jev.allowLegacyKeyRead, undefined);
    const r2 = M.runLegacyKeyOptInMigration(h.home, {});
    assert.strictEqual(r2.status, 'skipped');
    assert.match(r2.msg, /marker/);
    assert.strictEqual(readSettings(h.home).jev.allowLegacyKeyRead, undefined, 'not re-enabled');
  } finally { h.cleanup(); }
});

test("never overrides a value the user already set (explicit false stays false)", () => {
  const h = makeHome();
  try {
    h.writeState('settings.json', { jev: { enabled: true, allowLegacyKeyRead: false } });
    putKeyFile(h.home, KEY_REL, SECRET);
    const r = M.runLegacyKeyOptInMigration(h.home, {});
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(readSettings(h.home).jev.allowLegacyKeyRead, false);
  } finally { h.cleanup(); }
});

test('seeded-bad-state: corrupt settings.json is left byte-identical, reported failed, NOT stamped, retried later', () => {
  const h = makeHome();
  try {
    putKeyFile(h.home, KEY_REL, SECRET);
    fs.mkdirSync(path.join(h.home, '.anti-hall'), { recursive: true });
    fs.writeFileSync(settingsFile(h.home), '{ not json');
    let r;
    assert.doesNotThrow(() => { r = M.runLegacyKeyOptInMigration(h.home, {}); });
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(fs.readFileSync(settingsFile(h.home), 'utf8'), '{ not json');
    assert.strictEqual(fs.readdirSync(path.join(h.home, '.anti-hall')).filter((f) => f.includes('corrupt')).length, 0);
    // repaired later -> retried and applied
    fs.writeFileSync(settingsFile(h.home), JSON.stringify({ jev: { enabled: true } }));
    assert.strictEqual(M.runLegacyKeyOptInMigration(h.home, {}).status, 'fixed');
  } finally { h.cleanup(); }
});

test('update.js settings-migrate stage carries the ENABLED notice', () => {
  const h = makeHome();
  try {
    h.writeState('settings.json', { jev: { enabled: true } });
    putKeyFile(h.home, KEY_REL, SECRET);
    const update = require('../../plugins/anti-hall/skills/update/scripts/update.js');
    assert.strictEqual(typeof update.settingsMigratePostUpdate, 'function');
    const r = update.settingsMigratePostUpdate({ home: h.home, version: '9.9.9-test' });
    assert.match(r.detail, /legacy-key-opt-in fixed: ENABLED jev\.allowLegacyKeyRead/);
  } finally { h.cleanup(); }
});
