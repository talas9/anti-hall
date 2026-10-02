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
      cred.resolveKey('jev', { home: h.home, env: {}, keyFile, transport: 'vercel', allowLegacy: true }),
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

// ---------------------------------------------------------------------------
// key-file hardening: real path under ~/.config or ~/.anti-hall, regular file,
// <= 4096 bytes, one line with no whitespace. Rejections never echo content.
// ---------------------------------------------------------------------------

function legacyResolve(h, keyFile) {
  return cred.resolveKey('jev', { home: h.home, env: {}, keyFile, transport: 'vercel', allowLegacy: true });
}

test('key file: a normal file under ~/.config (and ~/.anti-hall) is accepted', () => {
  const h = makeHome();
  try {
    assert.deepStrictEqual(legacyResolve(h, keyFileIn(h, 'good-key-123\n')), { key: 'good-key-123', source: 'legacy-file' });
    const p = path.join(h.home, '.anti-hall', 'jevkey');
    fs.writeFileSync(p, 'other-key');
    assert.strictEqual(legacyResolve(h, p).key, 'other-key');
  } finally { h.cleanup(); }
});

test('key file: a path outside ~/.config and ~/.anti-hall is rejected, content never echoed', () => {
  const h = makeHome();
  try {
    const p = path.join(h.home, 'elsewhere-key');
    fs.writeFileSync(p, 'outside-secret-value');
    const r = legacyResolve(h, p);
    assert.strictEqual(r.key, null);
    assert.match(r.rejected, /outside/);
    assert.doesNotMatch(JSON.stringify(r) + cred.rejectedNotice(r.rejected), /outside-secret-value/);
  } finally { h.cleanup(); }
});

test('key file: a symlink under ~/.config pointing outside the roots is rejected; one pointing inside is accepted', () => {
  const h = makeHome();
  try {
    const target = path.join(h.home, 'real-secret');
    fs.writeFileSync(target, 'symlink-secret');
    const link = path.join(h.home, '.config', 'escape');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
    const r = legacyResolve(h, link);
    assert.strictEqual(r.key, null);
    assert.match(r.rejected, /outside/);
    const inside = keyFileIn(h, 'inside-key');
    const okLink = path.join(h.home, '.config', 'alias');
    fs.symlinkSync(inside, okLink);
    assert.strictEqual(legacyResolve(h, okLink).key, 'inside-key');
  } finally { h.cleanup(); }
});

test('key file: multi-line, whitespace-containing, oversized and non-regular files are rejected', () => {
  const h = makeHome();
  try {
    const cases = [
      ['line1\nline2\n', /single line/],
      ['two words', /single line/],
      ['x'.repeat(4097), /larger than 4096/],
    ];
    for (const [body, re] of cases) {
      const r = legacyResolve(h, keyFileIn(h, body));
      assert.strictEqual(r.key, null);
      assert.match(r.rejected, re);
      assert.doesNotMatch(r.rejected, /line1|words|xxxx/);
    }
    const dir = path.join(h.home, '.config', 'adir');
    fs.mkdirSync(dir, { recursive: true });
    assert.match(legacyResolve(h, dir).rejected, /regular file/);
    // missing file / empty file = plain no-key, not a rejection
    assert.deepStrictEqual(legacyResolve(h, path.join(h.home, '.config', 'absent')), { key: null, source: null });
    assert.deepStrictEqual(legacyResolve(h, keyFileIn(h, '  \n')), { key: null, source: null });
  } finally { h.cleanup(); }
});

test('jevDecide path: a rejected key file yields no-key plus ONE stderr line without content', () => {
  const { spawnSync } = require('node:child_process');
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true });
    h.writeState('settings.json', { jev: { allowLegacyKeyRead: true } });
    keyFileIn(h, 'multi\nline-secret\n');
    const lib = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'jev-client.js');
    const code = "const c=require(" + JSON.stringify(lib) + ");(async()=>{const q={type:'noul',instructions:'q',criteria:{true:'a',false:'b'}};"
      + "const r=await c.jevDecide({question:q,state:'s'});await c.jevDecide({question:q,state:'s2'});console.log(JSON.stringify(r.reason));})();";
    const e = Object.assign({}, process.env, { HOME: h.home, ANTIHALL_INGEST_DRY_RUN: '1' });
    for (const k of Object.keys(e)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_') || /API_KEY$/.test(k)) delete e[k];
    const r = spawnSync(process.execPath, ['-e', code], { env: e, encoding: 'utf8', timeout: 20000 });
    assert.match(r.stdout, /no-key/);
    assert.strictEqual((r.stderr.match(/Jev key file rejected/g) || []).length, 1, 'reported once per process');
    assert.doesNotMatch(r.stdout + r.stderr, /line-secret/);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// homeOnly is enforced in the readers: get(), source() and reset() agree even
// if a future schema edit gives a homeOnly key env / pluginOption / legacy.
// ---------------------------------------------------------------------------

test('homeOnly: source()/get()/reset() ignore env, plugin option and legacy even on a synthetic entry that declares them', () => {
  const h = makeHome();
  const schema = require('../../plugins/anti-hall/hooks/lib/settings-schema.js');
  const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');
  const synthetic = {
    section: 'synth', key: 'flag', type: 'boolean', default: false, homeOnly: true,
    locked: true, safetyDirection: 'on', safetyNote: 'synthetic',
    env: 'SYNTH_FLAG_ENV', pluginOption: 'synth_flag', legacy: { file: 'synth.json', key: 'flag' },
  };
  const realFind = schema.findSetting;
  schema.findSetting = (sec, key) => (sec === 'synth' && key === 'flag' ? synthetic : realFind(sec, key));
  try {
    h.writeState('synth.json', { flag: true });
    const env = { SYNTH_FLAG_ENV: '1', CLAUDE_PLUGIN_OPTION_SYNTH_FLAG: 'true' };
    const o = { home: h.home, env };
    assert.strictEqual(settings.get('synth', 'flag', undefined, o), false);
    assert.strictEqual(settings.source('synth', 'flag', o), 'default');
    h.writeState('settings.json', { synth: { flag: true } });
    assert.strictEqual(settings.source('synth', 'flag', o), 'file');
    assert.strictEqual(settings.get('synth', 'flag', undefined, o), true);
    // reset from true: the value after removal is the default (false) — env/legacy
    // must not leak in and turn a "safe" reset into a risky-looking one
    assert.deepStrictEqual(settings.reset('synth', 'flag', o), { ok: true });
    assert.strictEqual(settings.get('synth', 'flag', undefined, o), false);
  } finally {
    schema.findSetting = realFind;
    h.cleanup();
  }
});
