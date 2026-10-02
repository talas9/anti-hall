'use strict';
// A Jev key is NEVER sent to a vendor it was not entered for, whatever flips
// jev.transport / jev.fallbackTransport (env or /config plugin option), plus the
// hardening around it: no redirects, a corrupt breaker file cannot hold a vendor
// open, and a slow primary under the shortened fallback budget does not trip the
// breaker. Loopback mocks only.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');

const HOOKS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib');
const LIBS = ['jev-client.js', 'credentials.js', 'settings.js'].map((f) => require.resolve(path.join(HOOKS, f)));
function fresh() { for (const l of LIBS) delete require.cache[l]; return require(path.join(HOOKS, 'jev-client.js')); }

const ENV_KEYS = [
  'HOME', 'ANTIHALL_JEV', 'AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY',
  'CLAUDE_PLUGIN_OPTION_JEV_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY',
  'CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT', 'CLAUDE_PLUGIN_OPTION_JEV_FALLBACK_TRANSPORT',
  'ANTIHALL_JEV_TEST_ENDPOINT', 'ANTIHALL_JEV_TEST_ENDPOINT_VERCEL', 'ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE',
];
async function withEnv(o, fn) {
  const saved = {}; for (const k of ENV_KEYS) saved[k] = process.env[k];
  try { for (const k of ENV_KEYS) delete process.env[k]; Object.assign(process.env, o); return await fn(); }
  finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
// mock vendor: records the Authorization header of every request
async function mock(handler) {
  const auths = [];
  const server = http.createServer((req, res) => {
    auths.push(req.headers.authorization || null);
    req.resume();
    req.on('end', () => handler(req, res));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.auths = auths;
  server.url = `http://127.0.0.1:${server.address().port}/m`;
  server.stop = () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); });
  return server;
}
const ok = (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ answers: { decision: { noul: 0.95 } } })); };
const fail500 = (req, res) => { res.writeHead(500); res.end('{}'); };
const Q = { type: 'noul', instructions: 'x', criteria: { true: 't', false: 'f' } };

async function scenario({ files, env, ps = ok, vs = ok }, fn) {
  const h = makeHome();
  const ts = await mock(ps);
  const vc = await mock(vs);
  try {
    for (const [name, obj] of Object.entries(files)) h.writeState(name, obj);
    await withEnv(Object.assign({
      HOME: h.home, ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE: ts.url, ANTIHALL_JEV_TEST_ENDPOINT_VERCEL: vc.url,
    }, env), () => fn({ ts, vc, home: h.home }));
  } finally { await ts.stop(); await vc.stop(); h.cleanup(); }
}
async function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (c) => { out += String(c); return true; };
  try { await fn(); } finally { process.stderr.write = orig; }
  return out;
}

test('P1: an env/plugin-option transport flip with only a vercel key sends NOTHING to typesafe, with a diagnostic', async () => {
  await scenario({
    files: { 'jev.json': { enabled: true }, 'settings.json': { jev: { enabled: true } } },
    env: { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'vercel-generic-key', CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT: 'typesafe' },
  }, async ({ ts, vc }) => {
    const jc = fresh();
    assert.strictEqual(jc.loadJevConfig().transport, 'typesafe', 'precondition: the flip really changed the primary');
    let r;
    const err = await captureStderr(async () => { r = await jc.jevDecide({ question: Q, state: 's' }); });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-key');
    assert.strictEqual(ts.auths.length, 0, 'typesafe received nothing');
    assert.strictEqual(vc.auths.length, 0);
    assert.match(err, /jev_api_key is bound to vercel; set jev_typesafe_api_key for typesafe/);
    assert.ok(!err.includes('vercel-generic-key'), 'the diagnostic never carries the key');
  });
});

test('P1: the same flip on jev.fallbackTransport never sends the generic key to the flipped fallback vendor', async () => {
  await scenario({
    files: { 'settings.json': { jev: { enabled: true, transport: 'vercel' } } },
    env: { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'vercel-generic-key', CLAUDE_PLUGIN_OPTION_JEV_FALLBACK_TRANSPORT: 'typesafe' },
    vs: fail500,
  }, async ({ ts, vc }) => {
    const jc = fresh();
    assert.strictEqual(jc.loadJevConfig().fallbackTransport, 'typesafe', 'precondition');
    const r = await jc.jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(vc.auths.length, 1, 'the primary (vercel, the key it was entered for) was tried');
    assert.deepStrictEqual(vc.auths, ['Bearer vercel-generic-key']);
    assert.strictEqual(ts.auths.length, 0, 'typesafe received nothing');
  });
});

test('P1: a generic key with a home transport of vercel is sent to vercel, and refused after an env flip to typesafe', async () => {
  await scenario({
    files: { 'settings.json': { jev: { enabled: true, transport: 'vercel' } } },
    env: { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'g-key' },
  }, async ({ ts, vc }) => {
    const r = await fresh().jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(vc.auths, ['Bearer g-key']);
    assert.strictEqual(ts.auths.length, 0);
  });
  await scenario({
    files: { 'settings.json': { jev: { enabled: true, transport: 'vercel' } } },
    env: { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'g-key', ANTIHALL_JEV: '1', CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT: 'typesafe' },
  }, async ({ ts, vc }) => {
    // settings.json says vercel and outranks the plugin option, so vercel stays primary
    const r = await fresh().jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.transport, 'vercel');
    assert.strictEqual(ts.auths.length, 0);
    assert.deepStrictEqual(vc.auths, ['Bearer g-key']);
  });
});

test('P1: vendor-named keys go only to their own vendor (typesafe primary fails, vercel fallback serves)', async () => {
  await scenario({
    files: { 'settings.json': { jev: { enabled: true, transport: 'typesafe', fallbackTransport: 'vercel' } } },
    env: { CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY: 'T-key', CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY: 'V-key' },
    ps: fail500,
  }, async ({ ts, vc }) => {
    const r = await fresh().jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fellBack, true);
    assert.deepStrictEqual(ts.auths, ['Bearer T-key']);
    assert.deepStrictEqual(vc.auths, ['Bearer V-key']);
  });
});

test('P1: a vendor-named key outranks the generic one and survives a transport flip', async () => {
  await scenario({
    files: { 'settings.json': { jev: { enabled: true } } },
    env: { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'g-key', CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY: 'T-key', CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT: 'typesafe' },
  }, async ({ ts, vc }) => {
    const r = await fresh().jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(ts.auths, ['Bearer T-key']);
    assert.strictEqual(vc.auths.length, 0);
  });
});

test('P1: credentials.resolveKey never returns the generic key for a vendor it is not bound to', () => {
  const h = makeHome();
  try {
    h.writeState('settings.json', { jev: { transport: 'typesafe' } });
    for (const k of ENV_KEYS) delete process.env[k];
    const cred = fresh() && require(path.join(HOOKS, 'credentials.js'));
    const env = { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'g' };
    assert.strictEqual(cred.genericKeyVendor({ home: h.home, env }), 'typesafe');
    assert.strictEqual(cred.resolveKey('jev', { vendor: 'typesafe', env, home: h.home }).key, 'g');
    const other = cred.resolveKey('jev', { vendor: 'vercel', env, home: h.home });
    assert.strictEqual(other.key, null);
    assert.match(other.diagnostic, /bound to typesafe; set jev_vercel_api_key for vercel/);
    // an env transport value never changes the binding
    assert.strictEqual(cred.genericKeyVendor({ home: h.home, env: { CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT: 'vercel', ANTIHALL_JEV_TRANSPORT: 'vercel' } }), 'typesafe');
  } finally { h.cleanup(); }
});

test('P2a: a 307 redirect is an error and the redirect target never receives a request (key or text)', async () => {
  const target = await mock(ok);
  const redirector = await mock((req, res) => { res.writeHead(307, { Location: target.url }); res.end(); });
  const h = makeHome();
  try {
    h.writeState('settings.json', { jev: { enabled: true, transport: 'vercel' } });
    await withEnv({ HOME: h.home, CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY: 'V', ANTIHALL_JEV_TEST_ENDPOINT_VERCEL: redirector.url }, async () => {
      const jc = fresh();
      const r = await jc.jevDecide({ question: Q, state: 's' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, 'network-error');
      assert.strictEqual(redirector.auths.length, 1);
      assert.strictEqual(target.auths.length, 0, 'the redirect target got no request');
      // the credits call carries the key too
      const c = await jc.getCreditBalance({});
      assert.strictEqual(c.ok, false);
      assert.strictEqual(target.auths.length, 0);
    });
  } finally { await redirector.stop(); await target.stop(); h.cleanup(); }
});

function breakerFile(home, obj) {
  const p = path.join(home, '.anti-hall', 'cache', 'jev-breaker.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}
const FB = { 'settings.json': { jev: { enabled: true, transport: 'typesafe', fallbackTransport: 'vercel', timeoutMs: 1500 } } };
const KEYS = { CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY: 'T', CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY: 'V' };

test('P2b: a corrupt openUntil (9e15, negative, non-finite) cannot hold a vendor open; a real one still does', async () => {
  for (const openUntil of [9e15, -5, 'x']) {
    await scenario({ files: FB, env: KEYS }, async ({ ts, home }) => {
      breakerFile(home, { typesafe: { fails: 3, openUntil } });
      const r = await fresh().jevDecide({ question: Q, state: 's' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(ts.auths.length, 1, `openUntil=${String(openUntil)} is treated as closed: the primary is probed`);
      assert.ok(!r.fellBack);
    });
  }
  await scenario({ files: FB, env: KEYS }, async ({ ts, vc, home }) => {
    breakerFile(home, { typesafe: { fails: 3, openUntil: Date.now() + 60000 } });
    const r = await fresh().jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.fellBack, true);
    assert.strictEqual(ts.auths.length, 0, 'a genuine open breaker still skips the primary');
    assert.strictEqual(vc.auths.length, 1);
  });
});

test('P2c: a primary timeout under the shortened fallback budget serves the fallback but never trips the breaker', async () => {
  await scenario({ files: FB, env: KEYS, ps: () => { /* never answers */ } }, async ({ ts, vc, home }) => {
    const jc = fresh();
    for (let i = 0; i < 4; i++) {
      const r = await jc.jevDecide({ question: Q, state: 's' + i });
      assert.strictEqual(r.ok, true, 'call ' + i);
      assert.strictEqual(r.fellBack, true);
    }
    assert.strictEqual(ts.auths.length, 4, 'the primary was tried every time: its breaker never opened');
    assert.strictEqual(vc.auths.length, 4);
    const bf = path.join(home, '.anti-hall', 'cache', 'jev-breaker.json');
    const state = fs.existsSync(bf) ? JSON.parse(fs.readFileSync(bf, 'utf8')) : {};
    assert.ok(!state.typesafe || !(state.typesafe.fails > 0), 'no failure was counted for the slow primary');
  });
});
