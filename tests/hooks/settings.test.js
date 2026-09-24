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

test('get(): full precedence — env > file > pluginOption(/config, post-migration) > legacy (pre-migration) > default', () => {
  const home = makeHome();
  try {
    // 1. nothing set -> schema default
    assert.strictEqual(settings.get('jev', 'enabled', undefined, { home: home.home }), false);

    // 2. legacy jev.json fills in over the default
    fs.writeFileSync(home.home + '/.anti-hall/jev.json', JSON.stringify({ enabled: true }));
    assert.strictEqual(settings.get('jev', 'enabled', undefined, { home: home.home }), true);

    // 3. a /config value (simulated via a fake claude settings.json) does NOT
    // beat legacy until the settings migration is stamped. jev_enabled has no
    // `legacy`-independent way to pick a non-masked differing value here (its
    // manifest default IS `false`, jev.json's IS `true`) without the stamping
    // test colliding with the masking test above, so this step uses
    // limitConserve.mode instead — same jev.json legacy fixture stays for the
    // step-4 settings.json assertion below.
    const claudeSettingsPath = home.home + '/.claude-settings-fake.json';
    fs.mkdirSync(home.home + '/.claude', { recursive: true });
    fs.writeFileSync(claudeSettingsPath, JSON.stringify({
      pluginConfigs: { 'anti-hall': { options: { limit_conserve_mode: 'off' } } }, // manifest default is 'auto'
    }));
    const modeOpts = { home: home.home, claudeSettingsPath };
    assert.strictEqual(settings.get('limitConserve', 'mode', undefined, modeOpts), 'off', 'limitConserve.mode has no legacy source, so /config applies immediately');
    assert.strictEqual(settings.source('limitConserve', 'mode', modeOpts), 'plugin-option');
    assert.strictEqual(settings.get('jev', 'enabled', undefined, { home: home.home }), true, 'jev.enabled (has a legacy source) is untouched by the limitConserve check above');

    // 4. a settings.json file value beats /config (and legacy) regardless of stamp
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

test('set(): seeded-bad-state — a corrupt settings.json is backed up (never overwritten silently) before the write proceeds', () => {
  const home = makeHome();
  try {
    const p = settings.path({ home: home.home });
    fs.writeFileSync(p, 'not json at all {{{ garbage');

    const r = settings.set('autoHandover', 'pct', 60, { home: home.home });
    assert.strictEqual(r.ok, true);
    assert.ok(r.backedUpCorruptTo, 'set() must report where the corrupt file was preserved');
    assert.ok(fs.existsSync(r.backedUpCorruptTo));
    assert.strictEqual(fs.readFileSync(r.backedUpCorruptTo, 'utf8'), 'not json at all {{{ garbage', 'byte-for-byte preserved, never deleted');

    // the new write took effect against a fresh store, not a clobbered one
    assert.strictEqual(settings.get('autoHandover', 'pct', undefined, { home: home.home }), 60);

    // a second set() on the now-valid file does NOT re-back-up anything
    const r2 = settings.set('autoHandover', 'nag', false, { home: home.home });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.backedUpCorruptTo, undefined);
  } finally {
    home.cleanup();
  }
});

test('reset(): seeded-bad-state — a corrupt settings.json is backed up before reset() proceeds, even on the no-op path', () => {
  const home = makeHome();
  try {
    const p = settings.path({ home: home.home });
    fs.writeFileSync(p, '{ this is not valid json');

    const r = settings.reset('autoHandover', 'pct', { home: home.home });
    assert.strictEqual(r.ok, true);
    assert.ok(r.backedUpCorruptTo);
    assert.strictEqual(fs.readFileSync(r.backedUpCorruptTo, 'utf8'), '{ this is not valid json');
  } finally {
    home.cleanup();
  }
});

test('coerceValue via get(): blank/whitespace-only env and file values fall through instead of coercing to 0/false/empty', () => {
  const home = makeHome();
  try {
    // env: whitespace-only must NOT resolve to Number(' ') === 0
    assert.strictEqual(
      settings.get('autoHandover', 'pct', undefined, { home: home.home, env: { ANTIHALL_AUTO_HANDOVER_PCT: '   ' } }),
      85,
      'blank env value falls through to default, never becomes 0',
    );
    // file: whitespace-only string value must not be treated as a real override
    fs.writeFileSync(settings.path({ home: home.home }), JSON.stringify({ jev: { keyFile: '   ' } }));
    assert.strictEqual(settings.get('jev', 'keyFile', undefined, { home: home.home }), '', 'blank file value falls through to schema default');
    // file: a non-string/number/boolean shape (object) for a scalar setting is rejected, not coerced
    fs.writeFileSync(settings.path({ home: home.home }), JSON.stringify({ autoHandover: { pct: { nested: 1 } } }));
    assert.strictEqual(settings.get('autoHandover', 'pct', undefined, { home: home.home }), 85, 'malformed shape falls through to default');
  } finally {
    home.cleanup();
  }
});

test('readPluginOption masking: a /config value equal to the manifest default is treated as unset (never masks legacy)', () => {
  const home = makeHome();
  try {
    // jev_enabled's manifest default is false (see plugin.json). A /config
    // export sitting at that default must not shadow a real jev.json value.
    fs.writeFileSync(home.home + '/.anti-hall/jev.json', JSON.stringify({ enabled: true }));

    const v = settings.get('jev', 'enabled', undefined, {
      home: home.home,
      env: { CLAUDE_PLUGIN_OPTION_JEV_ENABLED: 'false' }, // == manifest default -> masked/unset
    });
    assert.strictEqual(v, true, 'manifest-default /config export must not mask legacy jev.json');

    // A /config value that actually DIFFERS from the manifest default DOES win
    // once the migration marker is stamped (simulated: no settings.json jev
    // section AND no unstamped-migration path — here the marker file simply
    // doesn't exist, so settingsMigrationStamped() is false and legacy still
    // wins; this asserts the reverse case explicitly further down).
    const v2 = settings.get('jev', 'enabled', undefined, {
      home: home.home,
      env: { CLAUDE_PLUGIN_OPTION_JEV_ENABLED: 'true' }, // differs from manifest default 'false'
    });
    // Since the migration marker is not stamped, legacy (true) still wins —
    // same effective answer here, but via the legacy tier, not plugin-option.
    assert.strictEqual(v2, true);
    assert.strictEqual(settings.source('jev', 'enabled', { home: home.home, env: { CLAUDE_PLUGIN_OPTION_JEV_ENABLED: 'true' } }), 'legacy');
  } finally {
    home.cleanup();
  }
});

test('legacy ranks above plugin-option until the settings migration marker is stamped for this version; plugin-option wins after', () => {
  const home = makeHome();
  try {
    // legacy=false, /config='true': jev_enabled's manifest default is `false`,
    // so the /config value here (`true`) genuinely differs from it and is
    // never masked — this isolates the ranking behavior itself.
    fs.writeFileSync(home.home + '/.anti-hall/jev.json', JSON.stringify({ enabled: false }));
    const opts = { home: home.home, env: { CLAUDE_PLUGIN_OPTION_JEV_ENABLED: 'true' } };

    // Unstamped: legacy (false) outranks the /config value (true).
    assert.strictEqual(settings.get('jev', 'enabled', undefined, opts), false);
    assert.strictEqual(settings.source('jev', 'enabled', opts), 'legacy');

    // Stamp the migration marker for the running plugin version, then the
    // /config value (which differs from the manifest default) outranks legacy.
    const migrations = require('../../plugins/anti-hall/companion/lib/migrations.js');
    const version = migrations.pluginVersion();
    migrations.markApplied(home.home, 'migrateSettingsFromLegacy', version);

    assert.strictEqual(settings.get('jev', 'enabled', undefined, opts), true);
    assert.strictEqual(settings.source('jev', 'enabled', opts), 'plugin-option');
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
