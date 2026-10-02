'use strict';
// credentials.js — resolution order, the legacy opt-in, and the migration
// notice. Every case injects env/allowLegacy explicitly; HOME is a tmp dir so
// nothing reads the real machine's key files or settings.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');

const cred = require('../../plugins/anti-hall/hooks/lib/credentials.js');

function keyFileIn(h, content) {
  const p = path.join(h.home, '.config', 'vercel', 'ai-gateway-key');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('plugin option wins over every legacy source, opt-in on or off', () => {
  const h = makeHome();
  try {
    const keyFile = keyFileIn(h, 'file-key\n');
    const env = { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: ' opt-key ', AI_GATEWAY_API_KEY: 'env-key' };
    for (const allowLegacy of [false, true]) {
      const r = cred.resolveKey('jev', { env, keyFile, transport: 'vercel', allowLegacy });
      assert.deepStrictEqual(r, { key: 'opt-key', source: 'plugin-option' });
    }
  } finally { h.cleanup(); }
});

test('opt-in OFF: legacy env var and key file are NOT read', () => {
  const h = makeHome();
  try {
    const keyFile = keyFileIn(h, 'file-key\n');
    const r = cred.resolveKey('jev', { env: { AI_GATEWAY_API_KEY: 'env-key', TYPESAFE_API_KEY: 't' }, keyFile, transport: 'vercel', allowLegacy: false });
    assert.deepStrictEqual(r, { key: null, source: null });
    const a = cred.resolveKey('anthropic', { env: { ANTHROPIC_API_KEY: 'sk-ant-x' }, allowLegacy: false });
    assert.deepStrictEqual(a, { key: null, source: null });
  } finally { h.cleanup(); }
});

test('opt-in ON: legacy env first, then key file; transport picks the env var', () => {
  const h = makeHome();
  try {
    const keyFile = keyFileIn(h, 'file-key\n');
    assert.deepStrictEqual(
      cred.resolveKey('jev', { env: { AI_GATEWAY_API_KEY: 'env-key' }, keyFile, transport: 'vercel', allowLegacy: true }),
      { key: 'env-key', source: 'legacy-env' });
    assert.deepStrictEqual(
      cred.resolveKey('jev', { env: {}, keyFile, transport: 'vercel', allowLegacy: true }),
      { key: 'file-key', source: 'legacy-file' });
    assert.deepStrictEqual(
      cred.resolveKey('jev', { env: { TYPESAFE_API_KEY: 'ts', AI_GATEWAY_API_KEY: 'gw' }, transport: 'typesafe', allowLegacy: true }),
      { key: 'ts', source: 'legacy-env' });
    assert.deepStrictEqual(
      cred.resolveKey('anthropic', { env: { ANTHROPIC_API_KEY: 'sk-ant-x' }, allowLegacy: true }),
      { key: 'sk-ant-x', source: 'legacy-env' });
  } finally { h.cleanup(); }
});

test('the opt-ins are read from the home settings file, default off, PER KIND', () => {
  const h = makeHome();
  try {
    const o = { home: h.home, env: {} };
    assert.strictEqual(cred.allowLegacyKeyRead('jev', o), false);
    assert.strictEqual(cred.allowLegacyKeyRead('anthropic', o), false);
    h.writeState('settings.json', { jev: { allowLegacyKeyRead: true } });
    assert.strictEqual(cred.allowLegacyKeyRead('jev', o), true);
    assert.strictEqual(cred.allowLegacyKeyRead('anthropic', o), false, 'the Jev opt-in does not unlock the Anthropic key');
    h.writeState('settings.json', { guards: { allowAnthropicEnvKey: true } });
    assert.strictEqual(cred.allowLegacyKeyRead('jev', o), false, 'the Anthropic opt-in does not unlock the Jev key');
    assert.strictEqual(cred.allowLegacyKeyRead('anthropic', o), true);
  } finally { h.cleanup(); }
});

test('an env var (or /config plugin option env) can NOT enable either opt-in', () => {
  const h = makeHome();
  try {
    const keyFile = keyFileIn(h, 'file-key\n');
    const env = {
      ANTIHALL_ALLOW_LEGACY_KEY_READ: '1', ANTIHALL_ALLOW_ANTHROPIC_ENV_KEY: '1',
      CLAUDE_PLUGIN_OPTION_JEV_ALLOW_LEGACY_KEY_READ: 'true', CLAUDE_PLUGIN_OPTION_GUARDS_ALLOW_ANTHROPIC_ENV_KEY: 'true',
      AI_GATEWAY_API_KEY: 'gw', ANTHROPIC_API_KEY: 'sk-ant-x',
    };
    assert.strictEqual(cred.allowLegacyKeyRead('jev', { home: h.home, env }), false);
    assert.strictEqual(cred.allowLegacyKeyRead('anthropic', { home: h.home, env }), false);
    // end to end through the settings default path (no allowLegacy override):
    assert.deepStrictEqual(cred.resolveKey('jev', { home: h.home, env, keyFile, transport: 'vercel' }), { key: null, source: null });
    assert.deepStrictEqual(cred.resolveKey('anthropic', { home: h.home, env }), { key: null, source: null });
    // the settings layer itself: homeOnly keys ignore every non-file tier
    const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');
    assert.strictEqual(settings.get('jev', 'allowLegacyKeyRead', undefined, { home: h.home, env }), false);
    assert.strictEqual(settings.get('guards', 'allowAnthropicEnvKey', undefined, { home: h.home, env }), false);
  } finally { h.cleanup(); }
});

test('the opt-ins are schema homeOnly + locked(on) with no env name, and are not plugin options', () => {
  const schema = require('../../plugins/anti-hall/hooks/lib/settings-schema.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json'), 'utf8'));
  for (const [sec, key] of [['jev', 'allowLegacyKeyRead'], ['guards', 'allowAnthropicEnvKey']]) {
    const e = schema.findSetting(sec, key);
    assert.ok(e, sec + '.' + key + ' exists');
    assert.strictEqual(e.default, false);
    assert.strictEqual(e.homeOnly, true);
    assert.strictEqual(e.locked, true);
    assert.strictEqual(e.safetyDirection, 'on');
    assert.strictEqual(e.env, undefined, 'no env mapping');
    assert.strictEqual(e.pluginOption, undefined, 'no /config mapping (project-scoped config could flip it)');
  }
  for (const k of Object.keys(manifest.userConfig)) assert.doesNotMatch(k, /allow_legacy|allow_anthropic/);
  for (const k of ['jev_api_key', 'anthropic_api_key']) {
    assert.strictEqual(manifest.userConfig[k].sensitive, true);
    assert.strictEqual(manifest.userConfig[k].default, undefined);
  }
});

test('legacyNotices: names the option and the setting, never the key; silent once opted in', () => {
  const h = makeHome();
  try {
    const keyFile = keyFileIn(h, 'super-secret-file-key\n');
    const env = { ANTHROPIC_API_KEY: 'sk-ant-super-secret' };
    const off = cred.legacyNotices({ home: h.home, env, keyFile, transport: 'vercel' });
    assert.strictEqual(off.length, 2);
    for (const n of off) {
      assert.match(n, /re-enter your key via \/plugin config \(anti-hall -> (jev_api_key|anthropic_api_key)\), or enable (jev\.allowLegacyKeyRead|guards\.allowAnthropicEnvKey)/);
      assert.doesNotMatch(n, /secret/);
    }
    assert.strictEqual(cred.legacyNotices({ home: h.home, env, keyFile, transport: 'vercel', kinds: ['jev'] }).length, 1);
    h.writeState('settings.json', { jev: { allowLegacyKeyRead: true } });
    const half = cred.legacyNotices({ home: h.home, env, keyFile, transport: 'vercel' });
    assert.strictEqual(half.length, 1, 'only the still-locked Anthropic kind remains');
    assert.match(half[0], /guards\.allowAnthropicEnvKey/);
    h.writeState('settings.json', { jev: { allowLegacyKeyRead: true }, guards: { allowAnthropicEnvKey: true } });
    assert.deepStrictEqual(cred.legacyNotices({ home: h.home, env, keyFile, transport: 'vercel' }), []);
  } finally { h.cleanup(); }
});

test('legacyNotices: nothing to say when no legacy key exists', () => {
  const h = makeHome();
  try {
    assert.deepStrictEqual(cred.legacyNotices({ home: h.home, env: {}, keyFile: path.join(h.home, 'nope'), transport: 'vercel' }), []);
  } finally { h.cleanup(); }
});

test('doctor: surfaces the legacy-key notice (jev enabled, opt-in off), never the key value', () => {
  const { spawnSync } = require('node:child_process');
  const doctorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  try {
    fs.mkdirSync(path.join(doctorHome, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(doctorHome, '.anti-hall', 'jev.json'), JSON.stringify({ enabled: true }));
    const env = Object.assign({}, process.env, { HOME: doctorHome, USERPROFILE: doctorHome, ANTIHALL_INGEST_DRY_RUN: '1', ANTHROPIC_API_KEY: 'sk-ant-doctor-secret' });
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_')) delete env[k];
    const doctor = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'doctor.js');
    const r = spawnSync(process.execPath, [doctor], { env, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /re-enter your key via \/plugin config \(anti-hall -> anthropic_api_key\)/);
    assert.doesNotMatch(out, /sk-ant-doctor-secret/);
    fs.writeFileSync(path.join(doctorHome, '.anti-hall', 'settings.json'), JSON.stringify({ guards: { allowAnthropicEnvKey: true } }));
    const r2 = spawnSync(process.execPath, [doctor], { env, encoding: 'utf8', timeout: 60000 });
    assert.doesNotMatch((r2.stdout || '') + (r2.stderr || ''), /re-enter your key via/);
  } finally { fs.rmSync(doctorHome, { recursive: true, force: true }); }
});
