'use strict';
// v0.108.0 contract 2 — scripts/settings.js (show/get/set/reset/--json/--all)
// and its precedence chain: env > settings.json > /config (pluginConfigs /
// CLAUDE_PLUGIN_OPTION_*) > legacy (jev.json) > default.
//
// Every test spawns the REAL `node scripts/settings.js ...` CLI as a
// subprocess with an isolated HOME (never the real machine's ~/.anti-hall).
// This feature is fully present in this working tree, so nothing here is
// gated.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeHome, rm, antiHallDir, settingsPath, readJson, writeJson,
  runCliScript, runMigrationsLib,
} = require('./lib.js');

function runSettings(home, args, extraEnv) {
  return runCliScript('settings.js', args, home, extraEnv);
}

// ── show ─────────────────────────────────────────────────────────────────
test('show: prints every section as a markdown table, defaults to collapsed advanced', () => {
  const home = makeHome();
  try {
    const r = runSettings(home, ['show']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /## Auto Handover/);
    assert.match(r.stdout, /## Jev/);
    assert.match(r.stdout, /advanced setting\(s\) hidden/);
  } finally { rm(home); }
});

test('show --all: expands advanced settings into the table', () => {
  const home = makeHome();
  try {
    const r = runSettings(home, ['show', '--all']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /confidenceThreshold/);
    assert.doesNotMatch(r.stdout, /advanced setting\(s\) hidden/);
  } finally { rm(home); }
});

test('show --section: filters to exactly one section', () => {
  const home = makeHome();
  try {
    const r = runSettings(home, ['show', '--section', 'jev']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /## Jev/);
    assert.doesNotMatch(r.stdout, /## Auto Handover/);
  } finally { rm(home); }
});

test('show --section unknown: exits 1 with a stderr message', () => {
  const home = makeHome();
  try {
    const r = runSettings(home, ['show', '--section', 'nope']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /unknown section: nope/);
  } finally { rm(home); }
});

test('show --json: machine-readable, value/default/source/advanced per key', () => {
  const home = makeHome();
  try {
    const r = runSettings(home, ['show', '--json', '--section', 'autoHandover']);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.autoHandover.enabled.value, true);
    assert.strictEqual(out.autoHandover.enabled.source, 'default');
    assert.strictEqual(out.autoHandover.pct.default, 85);
  } finally { rm(home); }
});

// ── get ──────────────────────────────────────────────────────────────────
test('get: reports the effective value, source, and default for a known key', () => {
  const home = makeHome();
  try {
    const r = runSettings(home, ['get', 'autoHandover.pct', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepStrictEqual(out, { section: 'autoHandover', key: 'pct', value: 85, source: 'default', default: 85 });
  } finally { rm(home); }
});

test('get: unknown section.key exits 1', () => {
  const home = makeHome();
  try {
    const r = runSettings(home, ['get', 'autoHandover.doesNotExist']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /unknown setting/);
  } finally { rm(home); }
});

// ── set / reset ──────────────────────────────────────────────────────────
test('set: writes settings.json and get then reflects the new value with source=file', () => {
  const home = makeHome();
  try {
    const setRes = runSettings(home, ['set', 'autoHandover.pct', '70', '--json']);
    assert.strictEqual(setRes.status, 0, setRes.stderr);
    assert.deepStrictEqual(JSON.parse(setRes.stdout), { ok: true, section: 'autoHandover', key: 'pct', value: 70 });

    const getRes = runSettings(home, ['get', 'autoHandover.pct', '--json']);
    const out = JSON.parse(getRes.stdout);
    assert.strictEqual(out.value, 70);
    assert.strictEqual(out.source, 'file');

    const onDisk = readJson(settingsPath(home));
    assert.strictEqual(onDisk.autoHandover.pct, 70);
  } finally { rm(home); }
});

test('set: rejects an out-of-range number without writing the file', () => {
  const home = makeHome();
  try {
    const r = runSettings(home, ['set', 'autoHandover.pct', '150', '--json']);
    assert.strictEqual(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /must be <= 99/);
    assert.ok(!fs.existsSync(settingsPath(home)), 'invalid set must not create settings.json');
  } finally { rm(home); }
});

test('set: rejects an invalid enum value', () => {
  const home = makeHome();
  try {
    const r = runSettings(home, ['set', 'jev.transport', 'carrier-pigeon', '--json']);
    assert.strictEqual(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /must be one of/);
  } finally { rm(home); }
});

test('set: rejects a non-boolean value for a boolean setting', () => {
  const home = makeHome();
  try {
    const r = runSettings(home, ['set', 'autoHandover.enabled', 'maybe', '--json']);
    assert.strictEqual(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /expected a boolean/);
  } finally { rm(home); }
});

test('set: an atomic write preserves every OTHER section already on disk', () => {
  const home = makeHome();
  try {
    writeJson(settingsPath(home), { jev: { enabled: true, transport: 'typesafe' } });
    const r = runSettings(home, ['set', 'autoHandover.pct', '60', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);

    const onDisk = readJson(settingsPath(home));
    assert.strictEqual(onDisk.jev.enabled, true);
    assert.strictEqual(onDisk.jev.transport, 'typesafe');
    assert.strictEqual(onDisk.autoHandover.pct, 60);
  } finally { rm(home); }
});

test('reset: removes the settings.json override, falling back to default', () => {
  const home = makeHome();
  try {
    runSettings(home, ['set', 'autoHandover.pct', '42']);
    const resetRes = runSettings(home, ['reset', 'autoHandover.pct', '--json']);
    assert.strictEqual(resetRes.status, 0, resetRes.stderr);
    assert.deepStrictEqual(JSON.parse(resetRes.stdout), { ok: true, section: 'autoHandover', key: 'pct', value: 85 });

    const onDisk = readJson(settingsPath(home));
    assert.ok(!onDisk.autoHandover || !('pct' in onDisk.autoHandover), 'pct override must be gone');
  } finally { rm(home); }
});

test('reset: a key never overridden is a harmless no-op success', () => {
  const home = makeHome();
  try {
    const r = runSettings(home, ['reset', 'autoHandover.pct', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), { ok: true, section: 'autoHandover', key: 'pct', value: 85 });
  } finally { rm(home); }
});

// ── precedence chain: env > settings.json > /config > legacy > default ────
test('precedence: settings.json beats legacy jev.json', () => {
  const home = makeHome();
  try {
    writeJson(path.join(antiHallDir(home), 'jev.json'), { transport: 'typesafe' });
    writeJson(settingsPath(home), { jev: { transport: 'vercel' } });
    const r = runSettings(home, ['get', 'jev.transport', '--json']);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.value, 'vercel');
    assert.strictEqual(out.source, 'file');
  } finally { rm(home); }
});

test('precedence: legacy jev.json is used when settings.json has no override', () => {
  const home = makeHome();
  try {
    writeJson(path.join(antiHallDir(home), 'jev.json'), { transport: 'typesafe' });
    const r = runSettings(home, ['get', 'jev.transport', '--json']);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.value, 'typesafe');
    assert.strictEqual(out.source, 'legacy');
  } finally { rm(home); }
});

test('precedence: /config (pluginConfigs in ~/.claude/settings.json) beats legacy but loses to settings.json', () => {
  const home = makeHome();
  try {
    writeJson(path.join(antiHallDir(home), 'jev.json'), { enabled: false });
    writeJson(path.join(home, '.claude', 'settings.json'), {
      pluginConfigs: { 'anti-hall': { options: { jev_enabled: true } } },
    });
    let r = runSettings(home, ['get', 'jev.enabled', '--json']);
    let out = JSON.parse(r.stdout);
    assert.strictEqual(out.value, true);
    assert.strictEqual(out.source, 'plugin-option');

    writeJson(settingsPath(home), { jev: { enabled: false } });
    r = runSettings(home, ['get', 'jev.enabled', '--json']);
    out = JSON.parse(r.stdout);
    assert.strictEqual(out.value, false);
    assert.strictEqual(out.source, 'file');
  } finally { rm(home); }
});

test('precedence: env var (ANTIHALL_*) wins over settings.json, /config, and legacy', () => {
  const home = makeHome();
  try {
    writeJson(settingsPath(home), { jev: { judgeModel: 'from-file' } });
    const r = runSettings(home, ['get', 'jev.judgeModel', '--json'], { ANTIHALL_JUDGE_MODEL: 'claude-opus-4-6' });
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.value, 'claude-opus-4-6');
    assert.strictEqual(out.source, 'env');
  } finally { rm(home); }
});

test('precedence: CLAUDE_PLUGIN_OPTION_* env (hook-process form) beats a ~/.claude/settings.json scan', () => {
  const home = makeHome();
  try {
    writeJson(path.join(home, '.claude', 'settings.json'), {
      pluginConfigs: { 'anti-hall': { options: { auto_handover_pct: 60 } } },
    });
    const r = runSettings(home, ['get', 'autoHandover.pct', '--json'], { CLAUDE_PLUGIN_OPTION_AUTO_HANDOVER_PCT: '77' });
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.value, 77);
    assert.strictEqual(out.source, 'plugin-option');
  } finally { rm(home); }
});

test('no setting resolves to default when nothing overrides it, on a brand-new HOME', () => {
  const home = makeHome();
  try {
    const r = runSettings(home, ['get', 'guards.outputVerifyGuard', '--json']);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.value, true);
    assert.strictEqual(out.source, 'default');
  } finally { rm(home); }
});

// ── migration: legacy -> settings.json, idempotent, no-delete, no secrets ──
// Exercised via the SAME production module (companion/lib/migrations.js)
// doctor --repair and /anti-hall:update call — see lib.js's runMigrationsLib
// doc comment for why this suite does not spawn the full doctor.js repair
// pass (it also installs/verifies real launchd/systemd companions against
// the login session, out of scope and unsafe for an automated test).
test('migration: forward-migrates jev.json fields into settings.json, leaves jev.json byte-for-byte', () => {
  const home = makeHome();
  try {
    const jevJsonPath = path.join(antiHallDir(home), 'jev.json');
    const originalJevJson = JSON.stringify({ enabled: true, transport: 'vercel', keyFile: '/path/to/key', triage: false });
    fs.writeFileSync(jevJsonPath, originalJevJson, 'utf8');

    const r = runMigrationsLib('runSettingsMigration', home, { version: '0.108.0-test' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.result.status, 'fixed');
    assert.match(r.result.msg, /^4 legacy field\(s\) forward-migrated/, `expected 4 fields migrated, got ${JSON.stringify(r.result)}`);

    const onDisk = readJson(settingsPath(home));
    assert.strictEqual(onDisk.jev.enabled, true);
    assert.strictEqual(onDisk.jev.transport, 'vercel');
    assert.strictEqual(onDisk.jev.keyFile, '/path/to/key');
    assert.strictEqual(onDisk.jev.triage, false);

    // legacy file is untouched, byte-for-byte
    assert.strictEqual(fs.readFileSync(jevJsonPath, 'utf8'), originalJevJson);
  } finally { rm(home); }
});

test('migration: never copies a field the schema does not declare (no secret/unknown leakage)', () => {
  const home = makeHome();
  try {
    writeJson(path.join(antiHallDir(home), 'jev.json'), {
      enabled: true,
      keyFile: '/path/to/key',
      apiKey: 'sk-should-never-leak-into-settings-json',
    });
    const r = runMigrationsLib('runSettingsMigration', home, { version: '0.108.0-test' });
    assert.strictEqual(r.status, 0, r.stderr);

    const rawSettingsText = fs.readFileSync(settingsPath(home), 'utf8');
    assert.ok(!rawSettingsText.includes('sk-should-never-leak'), 'raw secret value must never reach settings.json');
    assert.ok(!rawSettingsText.includes('apiKey'), 'undeclared field name must never reach settings.json');
  } finally { rm(home); }
});

test('migration: idempotent — a second run with the same version reports skipped/already-applied, no double-write', () => {
  const home = makeHome();
  try {
    writeJson(path.join(antiHallDir(home), 'jev.json'), { transport: 'typesafe' });

    const first = runMigrationsLib('runSettingsMigration', home, { version: '0.108.0-test' });
    assert.strictEqual(first.result.status, 'fixed');

    // Simulate a user override AFTER the first migration — the marker means
    // a second run for the SAME version must not stomp it back to legacy.
    const setAfter = require(path.join(__dirname, '..', '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'settings.js'));
    setAfter.set('jev', 'transport', 'vercel', { home });

    const second = runMigrationsLib('runSettingsMigration', home, { version: '0.108.0-test' });
    assert.strictEqual(second.status, 0, second.stderr);
    assert.strictEqual(second.result.status, 'skipped');
    assert.match(second.result.msg, /already applied/);

    const onDisk = readJson(settingsPath(home));
    assert.strictEqual(onDisk.jev.transport, 'vercel', 'user override after first migration must survive a repeat run');
  } finally { rm(home); }
});

test('migration: a settings.json value the user already set is never overwritten by the legacy value', () => {
  const home = makeHome();
  try {
    writeJson(path.join(antiHallDir(home), 'jev.json'), { transport: 'typesafe' });
    writeJson(settingsPath(home), { jev: { transport: 'vercel' } });

    const r = runMigrationsLib('migrateSettingsFromLegacy', home);
    assert.strictEqual(r.status, 0, r.stderr);

    const onDisk = readJson(settingsPath(home));
    assert.strictEqual(onDisk.jev.transport, 'vercel', 'pre-existing user value must win over legacy');
  } finally { rm(home); }
});
