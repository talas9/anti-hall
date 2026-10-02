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

test('the opt-in is read from settings.json (the Codex path) and defaults to off', () => {
  const h = makeHome();
  try {
    assert.strictEqual(cred.allowLegacyKeyRead({ home: h.home, env: {} }), false);
    h.writeState('settings.json', { jev: { allowLegacyKeyRead: true } });
    assert.strictEqual(cred.allowLegacyKeyRead({ home: h.home, env: {} }), true);
    assert.strictEqual(cred.allowLegacyKeyRead({ home: h.home, env: { ANTIHALL_ALLOW_LEGACY_KEY_READ: '0' } }), false);
  } finally { h.cleanup(); }
});

test('legacyNotices: names the option and the setting, never the key; silent once opted in', () => {
  const h = makeHome();
  try {
    const keyFile = keyFileIn(h, 'super-secret-file-key\n');
    const env = { ANTHROPIC_API_KEY: 'sk-ant-super-secret' };
    const off = cred.legacyNotices({ home: h.home, env, keyFile, transport: 'vercel' });
    assert.strictEqual(off.length, 2);
    for (const n of off) {
      assert.match(n, /re-enter your key via \/plugin config \(anti-hall -> (jev_api_key|anthropic_api_key)\), or enable jev\.allowLegacyKeyRead/);
      assert.doesNotMatch(n, /secret/);
    }
    assert.strictEqual(cred.legacyNotices({ home: h.home, env, keyFile, transport: 'vercel', kinds: ['jev'] }).length, 1);
    h.writeState('settings.json', { jev: { allowLegacyKeyRead: true } });
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
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_') || k === 'ANTIHALL_ALLOW_LEGACY_KEY_READ') delete env[k];
    const doctor = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'doctor.js');
    const r = spawnSync(process.execPath, [doctor], { env, encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /re-enter your key via \/plugin config \(anti-hall -> anthropic_api_key\)/);
    assert.doesNotMatch(out, /sk-ant-doctor-secret/);
    env.ANTIHALL_ALLOW_LEGACY_KEY_READ = '1';
    const r2 = spawnSync(process.execPath, [doctor], { env, encoding: 'utf8', timeout: 60000 });
    assert.doesNotMatch((r2.stdout || '') + (r2.stderr || ''), /re-enter your key via/);
  } finally { fs.rmSync(doctorHome, { recursive: true, force: true }); }
});
