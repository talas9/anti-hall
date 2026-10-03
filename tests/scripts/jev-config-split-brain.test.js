'use strict';
// Regression: ~/.anti-hall/settings.json outranks the legacy jev.json, but
// jev-setup used to read/write jev.json only. `enable --transport typesafe`
// printed "transport: typesafe" while every hook kept using vercel, and the
// balance shown was a fresh VERCEL balance under the typesafe label.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { makeHome } = require('../helpers/fixtures.js');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const SETUP = path.join(PLUGIN, 'scripts', 'jev-setup.js');
const DOCTOR = path.join(PLUGIN, 'hooks', 'doctor.js');
const CLIENT = path.join(PLUGIN, 'hooks', 'lib', 'jev-client.js');

function envFor(home, extra) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ANTIHALL_INGEST_DRY_RUN: '1' }, extra);
  for (const k of ['ANTIHALL_JEV', 'CLAUDE_PLUGIN_OPTION_JEV_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT', 'CLAUDE_PLUGIN_OPTION_JEV_FALLBACK_TRANSPORT', 'AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY', 'ANTIHALL_JEV_TEST_ENDPOINT', 'ANTIHALL_JEV_TEST_ENDPOINT_VERCEL', 'ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE']) {
    if (!(extra && k in extra)) delete env[k];
  }
  return env;
}
function setup(home, args, extra) {
  return execFileSync(process.execPath, [SETUP, ...args], { env: envFor(home, extra), encoding: 'utf8', input: '' });
}
function effectiveFromClient(home) {
  const out = execFileSync(process.execPath, ['-e', `const c=require(${JSON.stringify(CLIENT)}).loadJevConfig();process.stdout.write(JSON.stringify({t:c.transport,f:c.fallbackTransport,e:c.enabled}))`], { env: envFor(home), encoding: 'utf8' });
  return JSON.parse(out);
}
// doctor.js is spawned only with an isolated HOME; the default is a disposable
// temp dir, never the real home (doctor-default-home-isolation convention).
function runDoctor(home) {
  const h = home || fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  return spawnSync(process.execPath, [DOCTOR], { env: envFor(h), encoding: 'utf8', timeout: 60000 });
}
function seed(home, file, obj) { fs.writeFileSync(path.join(home, '.anti-hall', file), JSON.stringify(obj)); }

test('settings.json says vercel; `enable --transport typesafe` -> client AND status both say typesafe', () => {
  const { home } = makeHome();
  seed(home, 'settings.json', { jev: { enabled: true, transport: 'vercel' } });
  setup(home, ['enable', '--transport', 'typesafe']);
  assert.strictEqual(effectiveFromClient(home).t, 'typesafe');
  assert.match(setup(home, ['status']), /^transport: typesafe$/m);
  assert.strictEqual(fs.existsSync(path.join(home, '.anti-hall', 'jev.json')), false, 'jev.json is not written');
});

test('settings.json says enabled:false; `enable` turns the hooks on; `disable` turns them off', () => {
  const { home } = makeHome();
  seed(home, 'settings.json', { jev: { enabled: false } });
  assert.strictEqual(effectiveFromClient(home).e, false);
  setup(home, ['enable']);
  assert.strictEqual(effectiveFromClient(home).e, true);
  assert.match(setup(home, ['status']), /^enabled: true$/m);
  setup(home, ['disable']);
  assert.strictEqual(effectiveFromClient(home).e, false);
});

test('enabled only in settings.json is honoured by the integration-mode gate (jev-assist getMode)', () => {
  const { home } = makeHome();
  seed(home, 'settings.json', { jev: { enabled: true } });
  const out = execFileSync(process.execPath, ['-e', `const a=require(${JSON.stringify(path.join(PLUGIN, 'hooks', 'lib', 'jev-assist.js'))});process.stdout.write(a.getMode('speculation', a.readJevJson(${JSON.stringify(home)}), ${JSON.stringify(home)}))`], { env: envFor(home), encoding: 'utf8' });
  assert.strictEqual(out, 'on');
});

test('status warns, naming both files, when a lower-precedence jev.json disagrees', () => {
  const { home } = makeHome();
  seed(home, 'settings.json', { jev: { enabled: true, transport: 'vercel' } });
  seed(home, 'jev.json', { enabled: true, transport: 'typesafe' });
  const out = setup(home, ['status']);
  assert.match(out, /^transport: vercel$/m, 'status shows the EFFECTIVE transport');
  assert.match(out, /warning: ~\/\.anti-hall\/jev\.json says transport="typesafe" but ~\/\.anti-hall\/settings\.json wins with "vercel"/);
});

test('doctor reports the same disagreement, and is silent when they agree', () => {
  const { home } = makeHome();
  seed(home, 'settings.json', { jev: { enabled: true, transport: 'vercel' } });
  seed(home, 'jev.json', { enabled: true, transport: 'typesafe' });
  const r = runDoctor(home);
  const out = r.stdout + r.stderr;
  assert.match(out, /jev\.transport: ~\/\.anti-hall\/jev\.json says "typesafe" but ~\/\.anti-hall\/settings\.json wins with "vercel"/);
  seed(home, 'jev.json', { enabled: true, transport: 'vercel' });
  const r2 = runDoctor(home);
  assert.doesNotMatch(r2.stdout + r2.stderr, /jev\.json says/);
});

function mockVercelCredits(balance) {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ balance, total_used: '1' })); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1/credits` })));
}
function runAsync(home, args, extra) {
  return new Promise((resolve) => {
    require('node:child_process').execFile(process.execPath, [SETUP, ...args], { env: envFor(home, extra) }, (err, stdout) => resolve(stdout));
  });
}

test('status balance: typesafe primary says "not available", never a vercel number; with a vercel fallback BOTH lines, labelled', async () => {
  const { home } = makeHome();
  seed(home, 'settings.json', { jev: { enabled: true, transport: 'typesafe' } });
  // a stale cached VERCEL balance must never show under the typesafe transport
  fs.mkdirSync(path.join(home, '.anti-hall', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, '.anti-hall', 'cache', 'jev-credits.json'), JSON.stringify({ fetchedAt: Date.now(), result: { ok: true, balanceUsd: 21.1, totalUsedUsd: 1, ms: 5 } }));
  const only = await runAsync(home, ['status'], { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'k' });
  assert.match(only, /credit balance \(typesafe\): not available/);
  assert.doesNotMatch(only, /21\.10/);

  const { server, url } = await mockVercelCredits('55.50');
  try {
    seed(home, 'settings.json', { jev: { enabled: true, transport: 'typesafe', fallbackTransport: 'vercel' } });
    const both = await runAsync(home, ['status'], { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'k', CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY: 'k2', ANTIHALL_JEV_TEST_ENDPOINT_VERCEL: url });
    assert.match(both, /credit balance \(typesafe\): not available/);
    assert.match(both, /credit balance \(vercel\): \$55\.50/);
    assert.doesNotMatch(both, /21\.10/, 'the untagged (pre-fix) cache entry is not served');
  } finally { server.close(); }
});

test('credit cache: only a vendor-tagged vercel entry is served; local config answers are never cached', async () => {
  const { home } = makeHome();
  seed(home, 'settings.json', { jev: { enabled: true, transport: 'typesafe' } });
  const cacheFile = path.join(home, '.anti-hall', 'cache', 'jev-credits.json');
  const script = `const c=require(${JSON.stringify(CLIENT)});c.getCreditBalanceCached({}).then(r=>process.stdout.write(JSON.stringify(r)))`;
  const call = () => JSON.parse(execFileSync(process.execPath, ['-e', script], { env: envFor(home, { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'k' }), encoding: 'utf8' }));
  const r = call();
  assert.strictEqual(r.reason, 'unsupported-transport');
  assert.strictEqual(r.transport, 'typesafe');
  assert.strictEqual(fs.existsSync(cacheFile), false, 'an unsupported-transport answer is not cached');
  // an entry tagged for another vendor is ignored too
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), vendor: 'typesafe', result: { ok: true, balanceUsd: 9 } }));
  assert.strictEqual(call().reason, 'unsupported-transport');
});
