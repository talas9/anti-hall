'use strict';
// settings.js — the unified ~/.anti-hall/settings.json store. Every test uses
// an isolated tmp HOME (never the real machine's ~/.anti-hall).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { makeHome } = require('../helpers/fixtures.js');
const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');

test('load(): fail-open on missing/corrupt settings.json', () => {
  const home = makeHome();
  try {
    assert.deepStrictEqual(settings.load({ home: home.home }), {});
    fs.writeFileSync(settings.path({ home: home.home }), 'not json {{{');
    assert.deepStrictEqual(settings.load({ home: home.home }), {});
    fs.writeFileSync(settings.path({ home: home.home }), JSON.stringify([1, 2, 3]));
    assert.deepStrictEqual(settings.load({ home: home.home }), {}, 'an array is not a valid store');
  } finally {
    home.cleanup();
  }
});

test('get(): schema default wins when nothing else resolves it', () => {
  const home = makeHome();
  try {
    assert.strictEqual(settings.get('autoHandover', 'pct', undefined, { home: home.home }), 85);
    assert.strictEqual(settings.get('jev', 'transport', undefined, { home: home.home }), 'vercel');
  } finally {
    home.cleanup();
  }
});

test('get(): full precedence — env > file > pluginOption(/config) > legacy > default', () => {
  const home = makeHome();
  try {
    // 1. nothing set -> schema default
    assert.strictEqual(settings.get('jev', 'enabled', undefined, { home: home.home }), false);

    // 2. legacy jev.json fills in over the default
    fs.writeFileSync(home.home + '/.anti-hall/jev.json', JSON.stringify({ enabled: true }));
    assert.strictEqual(settings.get('jev', 'enabled', undefined, { home: home.home }), true);

    // 3. a /config value (simulated via a fake claude settings.json) beats legacy
    const claudeSettingsPath = home.home + '/.claude-settings-fake.json';
    fs.mkdirSync(home.home + '/.claude', { recursive: true });
    fs.writeFileSync(claudeSettingsPath, JSON.stringify({
      pluginConfigs: { 'anti-hall': { options: { jev_enabled: false } } },
    }));
    assert.strictEqual(
      settings.get('jev', 'enabled', undefined, { home: home.home, claudeSettingsPath }),
      false,
      'a /config value overrides legacy',
    );

    // 4. a settings.json file value beats /config
    settings.set('jev', 'enabled', true, { home: home.home });
    assert.strictEqual(
      settings.get('jev', 'enabled', undefined, { home: home.home, claudeSettingsPath }),
      true,
      'settings.json overrides /config',
    );

    // 5. an env override beats everything
    assert.strictEqual(
      settings.get('jev', 'enabled', undefined, { home: home.home, claudeSettingsPath, env: { ANTIHALL_JEV: '0' } }),
      false,
      'env override is highest precedence',
    );
  } finally {
    home.cleanup();
  }
});

test('get(): CLAUDE_PLUGIN_OPTION_<KEY> env var is read before the file fallback', () => {
  const home = makeHome();
  try {
    const v = settings.get('statusline', 'noEmail', undefined, {
      home: home.home,
      env: { CLAUDE_PLUGIN_OPTION_STATUSLINE_NO_EMAIL: '1' },
    });
    assert.strictEqual(v, true);
  } finally {
    home.cleanup();
  }
});

test('set(): validates type/range/enum and rejects bad values without writing', () => {
  const home = makeHome();
  try {
    const before = settings.load({ home: home.home });
    let r = settings.set('autoHandover', 'pct', 150, { home: home.home });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /<=/);
    assert.deepStrictEqual(settings.load({ home: home.home }), before, 'a rejected set must not write');

    r = settings.set('jev', 'transport', 'nope', { home: home.home });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /one of/);

    r = settings.set('autoHandover', 'enabled', 'not-a-bool!', { home: home.home });
    assert.strictEqual(r.ok, false);

    r = settings.set('does-not-exist', 'key', 1, { home: home.home });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /unknown setting/);
  } finally {
    home.cleanup();
  }
});

test('set(): coerces string booleans/numbers (CLI passes strings) and round-trips', () => {
  const home = makeHome();
  try {
    assert.strictEqual(settings.set('autoHandover', 'nag', 'false', { home: home.home }).ok, true);
    assert.strictEqual(settings.get('autoHandover', 'nag', undefined, { home: home.home }), false);
    assert.strictEqual(settings.set('autoHandover', 'pct', '42', { home: home.home }).ok, true);
    assert.strictEqual(settings.get('autoHandover', 'pct', undefined, { home: home.home }), 42);
  } finally {
    home.cleanup();
  }
});

test('set(): preserves every other section and key untouched (read-modify-write, not overwrite)', () => {
  const home = makeHome();
  try {
    settings.set('autoHandover', 'pct', 70, { home: home.home });
    settings.set('jev', 'enabled', true, { home: home.home });
    settings.set('autoHandover', 'nag', false, { home: home.home });

    const store = settings.load({ home: home.home });
    assert.strictEqual(store.autoHandover.pct, 70);
    assert.strictEqual(store.autoHandover.nag, false);
    assert.strictEqual(store.jev.enabled, true);
  } finally {
    home.cleanup();
  }
});

test('set(): atomic write — no .tmp file left behind, and the write is all-or-nothing', () => {
  const home = makeHome();
  try {
    settings.set('autoHandover', 'pct', 60, { home: home.home });
    const dir = home.home + '/.anti-hall';
    const leftoverTmp = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepStrictEqual(leftoverTmp, [], 'no leftover tmp files after a successful write');
    assert.ok(fs.existsSync(settings.path({ home: home.home })));
  } finally {
    home.cleanup();
  }
});

test('reset(): removes only that key, falls back through the chain, is a no-op when nothing was set', () => {
  const home = makeHome();
  try {
    assert.strictEqual(settings.reset('autoHandover', 'pct', { home: home.home }).ok, true, 'no-op reset still ok');

    settings.set('autoHandover', 'pct', 55, { home: home.home });
    settings.set('autoHandover', 'nag', false, { home: home.home });
    settings.reset('autoHandover', 'pct', { home: home.home });

    assert.strictEqual(settings.get('autoHandover', 'pct', undefined, { home: home.home }), 85, 'back to default');
    assert.strictEqual(settings.get('autoHandover', 'nag', undefined, { home: home.home }), false, 'sibling key untouched');
  } finally {
    home.cleanup();
  }
});

test('source(): reports which precedence tier answered', () => {
  const home = makeHome();
  try {
    assert.strictEqual(settings.source('autoHandover', 'pct', { home: home.home }), 'default');
    fs.writeFileSync(home.home + '/.anti-hall/jev.json', JSON.stringify({ enabled: true }));
    assert.strictEqual(settings.source('jev', 'enabled', { home: home.home }), 'legacy');
    settings.set('jev', 'enabled', false, { home: home.home });
    assert.strictEqual(settings.source('jev', 'enabled', { home: home.home }), 'file');
    assert.strictEqual(settings.source('jev', 'enabled', { home: home.home, env: { ANTIHALL_JEV: '1' } }), 'env');
  } finally {
    home.cleanup();
  }
});
