'use strict';
// The legacy generic key (jev_api_key plugin option) and jev.keyFile carry no
// vendor name, so they are bound to ONE vendor by the homeOnly setting
// jev.genericKeyVendor (default vercel) — NOT by jev.transport, which a normal
// `jev-setup enable --transport` rewrites. Loopback mocks, isolated HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeHome } = require('../helpers/fixtures.js');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const HOOKS = path.join(PLUGIN, 'hooks', 'lib');
const SETUP = path.join(PLUGIN, 'scripts', 'jev-setup.js');
const LIBS = ['jev-client.js', 'credentials.js', 'settings.js'].map((f) => require.resolve(path.join(HOOKS, f)));
const fresh = () => { for (const l of LIBS) delete require.cache[l]; return require(path.join(HOOKS, 'jev-client.js')); };
const Q = { type: 'noul', instructions: 'x', criteria: { true: 't', false: 'f' } };
const ENV_KEYS = [
  'HOME', 'ANTIHALL_JEV', 'AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY',
  'CLAUDE_PLUGIN_OPTION_JEV_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY',
  'CLAUDE_PLUGIN_OPTION_JEV_GENERIC_KEY_VENDOR', 'ANTIHALL_JEV_GENERIC_KEY_VENDOR', 'CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT',
  'ANTIHALL_JEV_TEST_ENDPOINT', 'ANTIHALL_JEV_TEST_ENDPOINT_VERCEL', 'ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE',
];
async function withEnv(o, fn) {
  const saved = {}; for (const k of ENV_KEYS) saved[k] = process.env[k];
  try { for (const k of ENV_KEYS) delete process.env[k]; Object.assign(process.env, o); return await fn(); }
  finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
async function mock() {
  const auths = [];
  const server = http.createServer((req, res) => {
    auths.push(req.headers.authorization || null);
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ answers: { decision: { noul: 0.95 } } })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.auths = auths;
  server.url = `http://127.0.0.1:${server.address().port}/m`;
  server.stop = () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); });
  return server;
}
function setup(home, args, extraEnv) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ANTIHALL_INGEST_DRY_RUN: '1' }, extraEnv);
  for (const k of ENV_KEYS) if (k !== 'HOME' && !(extraEnv && k in extraEnv)) delete env[k];
  return spawnSync(process.execPath, [SETUP, ...args], { env, encoding: 'utf8', input: '' });
}
async function decide(home, ts, vc, env) {
  return withEnv(Object.assign({ HOME: home, ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE: ts.url, ANTIHALL_JEV_TEST_ENDPOINT_VERCEL: vc.url }, env),
    () => fresh().jevDecide({ question: Q, state: 's' }));
}
const readSettings = (home) => JSON.parse(fs.readFileSync(path.join(home, '.anti-hall', 'settings.json'), 'utf8'));

test('(a) generic key + `enable --transport typesafe` -> typesafe receives NOTHING, a warning is printed, the binding is unchanged', async () => {
  const h = makeHome(); const ts = await mock(); const vc = await mock();
  try {
    h.writeState('settings.json', { jev: { enabled: true, transport: 'vercel' } });
    const e = setup(h.home, ['enable', '--transport', 'typesafe'], { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'vercel-key' });
    assert.match(e.stdout, /warning: no key for typesafe is visible[^\n]*bound to vercel[^\n]*NOT be sent to typesafe/);
    assert.match(e.stdout, /set-key --transport typesafe/);
    assert.match(e.stdout, /jev_typesafe_api_key/);
    const s = readSettings(h.home);
    assert.strictEqual(s.jev.transport, 'typesafe', 'enable did change the transport');
    assert.strictEqual(s.jev.genericKeyVendor, undefined, 'and did NOT re-bind the generic key');
    const r = await decide(h.home, ts, vc, { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'vercel-key' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-key');
    assert.strictEqual(ts.auths.length, 0);
    assert.strictEqual(vc.auths.length, 0);
    const st = setup(h.home, ['status'], { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'vercel-key' });
    assert.match(st.stdout, /generic key \(jev_api_key \/ jev\.keyFile\) bound to: vercel/);
    assert.doesNotMatch(st.stdout, /vercel-key/);
  } finally { await ts.stop(); await vc.stop(); h.cleanup(); }
});

test('(b) bind-generic-key --vendor typesafe -> the generic key goes to typesafe and never to vercel', async () => {
  const h = makeHome(); const ts = await mock(); const vc = await mock();
  try {
    h.writeState('settings.json', { jev: { enabled: true, transport: 'typesafe' } });
    const b = setup(h.home, ['bind-generic-key', '--vendor', 'typesafe']);
    assert.strictEqual(b.status, 0);
    assert.match(b.stdout, /jev\.genericKeyVendor = typesafe/);
    assert.strictEqual(readSettings(h.home).jev.genericKeyVendor, 'typesafe');
    const r = await decide(h.home, ts, vc, { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'g' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(ts.auths, ['Bearer g']);
    assert.strictEqual(vc.auths.length, 0);
    // a vercel primary now refuses it
    h.writeState('settings.json', { jev: { enabled: true, transport: 'vercel', genericKeyVendor: 'typesafe' } });
    const r2 = await decide(h.home, ts, vc, { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'g' });
    assert.strictEqual(r2.reason, 'no-key');
    assert.strictEqual(vc.auths.length, 0);
    assert.notStrictEqual(setup(h.home, ['bind-generic-key']).status, 0, '--vendor is required');
  } finally { await ts.stop(); await vc.stop(); h.cleanup(); }
});

test('(c) jev.keyFile pointing at a vercel key file (legacy opt-in on) is never sent to typesafe, whatever jev.transport is', async () => {
  const h = makeHome(); const ts = await mock(); const vc = await mock();
  try {
    const kf = path.join(h.home, '.config', 'vercel', 'ai-gateway-key');
    fs.mkdirSync(path.dirname(kf), { recursive: true });
    fs.writeFileSync(kf, 'vercel-file-key\n');
    // d2: typesafe primary, no vendor-named typesafe key anywhere
    h.writeState('settings.json', { jev: { enabled: true, transport: 'typesafe', allowLegacyKeyRead: true, keyFile: kf } });
    let r = await decide(h.home, ts, vc, {});
    assert.strictEqual(r.reason, 'no-key');
    assert.strictEqual(ts.auths.length, 0, 'd2: nothing to typesafe');
    // d3: vercel primary, typesafe fallback; the keyFile (bound to vercel) serves only vercel
    h.writeState('settings.json', { jev: { enabled: true, transport: 'vercel', fallbackTransport: 'typesafe', allowLegacyKeyRead: true, keyFile: kf } });
    r = await decide(h.home, ts, vc, {});
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(vc.auths, ['Bearer vercel-file-key']);
    assert.strictEqual(ts.auths.length, 0, 'd3: nothing to typesafe');
    // deliberately bound to typesafe: now it goes to typesafe and not to vercel
    h.writeState('settings.json', { jev: { enabled: true, transport: 'typesafe', genericKeyVendor: 'typesafe', allowLegacyKeyRead: true, keyFile: kf } });
    vc.auths.length = 0;
    r = await decide(h.home, ts, vc, {});
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(ts.auths, ['Bearer vercel-file-key']);
    assert.strictEqual(vc.auths.length, 0);
  } finally { await ts.stop(); await vc.stop(); h.cleanup(); }
});

test('(d) jev.genericKeyVendor is homeOnly + locked: env, plugin option and jev.json cannot set it; a change needs --confirmed', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { genericKeyVendor: 'typesafe' });
    for (const k of ENV_KEYS) delete process.env[k];
    const cred = fresh() && require(path.join(HOOKS, 'credentials.js'));
    const env = { CLAUDE_PLUGIN_OPTION_JEV_GENERIC_KEY_VENDOR: 'typesafe', ANTIHALL_JEV_GENERIC_KEY_VENDOR: 'typesafe' };
    assert.strictEqual(cred.genericKeyVendor({ home: h.home, env }), 'vercel');
    const S = require(path.join(HOOKS, 'settings.js'));
    assert.strictEqual(S.get('jev', 'genericKeyVendor', undefined, { home: h.home, env }), 'vercel');
    assert.strictEqual(S.source('jev', 'genericKeyVendor', { home: h.home, env }), 'default');
    const entry = require(path.join(HOOKS, 'settings-schema.js')).findSetting('jev', 'genericKeyVendor');
    assert.ok(entry.homeOnly && entry.locked && !entry.env && !entry.pluginOption && !entry.legacy);
    const refused = S.set('jev', 'genericKeyVendor', 'typesafe', { home: h.home });
    assert.ok(!refused.ok, 'unconfirmed re-binding is refused');
    assert.strictEqual(S.get('jev', 'genericKeyVendor', undefined, { home: h.home, env: {} }), 'vercel');
    assert.ok(S.set('jev', 'genericKeyVendor', 'typesafe', { home: h.home, confirmed: true }).ok);
    assert.strictEqual(cred.genericKeyVendor({ home: h.home, env: {} }), 'typesafe');
  } finally { h.cleanup(); }
});

test('migration/notice: an existing typesafe install with a generic key and no recorded binding is NEVER auto-bound; a one-time notice says how to bind', () => {
  const h = makeHome();
  const savedHome = process.env.HOME;
  try {
    h.writeState('settings.json', { jev: { enabled: true, transport: 'typesafe' } });
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.HOME = h.home; // key-file presence probes use os.homedir()
    const cred = fresh() && require(path.join(HOOKS, 'credentials.js'));
    const env = { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'generic-secret' };
    const before = fs.readFileSync(path.join(h.home, '.anti-hall', 'settings.json'), 'utf8');
    const n = cred.sessionNotice({ home: h.home, env });
    assert.match(n, /generic Jev key[^\n]*bound to vercel and is NOT sent to typesafe/);
    assert.match(n, /bind-generic-key --vendor typesafe/);
    assert.doesNotMatch(n, /generic-secret/);
    assert.strictEqual(cred.sessionNotice({ home: h.home, env }), null, 'shown once');
    assert.strictEqual(readSettings(h.home).jev.genericKeyVendor, undefined, 'never auto-bound');
    assert.strictEqual(JSON.parse(before).jev.transport, 'typesafe');
    assert.strictEqual(cred.genericKeyVendor({ home: h.home, env }), 'vercel');
  } finally { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; h.cleanup(); }
});

test('notice: keyed on the EFFECTIVE transport, so a typesafe transport from the plugin option (not home settings) still gets the one-time binding notice', () => {
  const h = makeHome();
  const savedHome = process.env.HOME;
  try {
    h.writeState('settings.json', { jev: { enabled: true } }); // no transport in home settings
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.HOME = h.home;
    const cred = fresh() && require(path.join(HOOKS, 'credentials.js'));
    const env = { CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT: 'typesafe', CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'generic-secret' };
    const n = cred.sessionNotice({ home: h.home, env });
    assert.match(n, /generic Jev key[^\n]*bound to vercel and is NOT sent to typesafe/);
    assert.strictEqual(cred.sessionNotice({ home: h.home, env }), null, 'shown once');
  } finally { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; h.cleanup(); }
});

test('notice: silent for a vercel install, with no generic key, or once a binding is recorded', () => {
  for (const [settings, env] of [
    [{ jev: { enabled: true, transport: 'vercel' } }, { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'g' }],
    [{ jev: { enabled: true, transport: 'typesafe' } }, {}],
    [{ jev: { enabled: true, transport: 'typesafe', genericKeyVendor: 'typesafe' } }, { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'g' }],
  ]) {
    const h = makeHome();
    try {
      h.writeState('settings.json', settings);
      const savedHome = process.env.HOME;
      for (const k of ENV_KEYS) delete process.env[k];
      process.env.HOME = h.home; // key-file presence probes use os.homedir(): keep them off the real home
      try {
        const cred = fresh() && require(path.join(HOOKS, 'credentials.js'));
        assert.strictEqual(cred.sessionNotice({ home: h.home, env }), null);
      } finally { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; }
    } finally { h.cleanup(); }
  }
});
