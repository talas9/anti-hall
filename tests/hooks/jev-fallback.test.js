'use strict';
// jev.fallbackTransport — primary vendor fails, ONE retry on the backup vendor.
// Two loopback mock servers stand in for the two vendors (per-transport test
// endpoint overrides, loopback-only); HOME is an isolated fixture.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');

const HOOKS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib');
const LIBS = ['jev-client.js', 'jev-assist.js'].map((f) => require.resolve(path.join(HOOKS, f)));
function fresh(name) {
  for (const l of LIBS) delete require.cache[l];
  return require(path.join(HOOKS, name));
}

const ENV_KEYS = [
  'HOME', 'ANTIHALL_JEV', 'AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY',
  'CLAUDE_PLUGIN_OPTION_JEV_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT', 'CLAUDE_PLUGIN_OPTION_JEV_FALLBACK_TRANSPORT',
  'ANTIHALL_JEV_TEST_ENDPOINT', 'ANTIHALL_JEV_TEST_ENDPOINT_VERCEL', 'ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE',
];
async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, overrides);
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

// A mock vendor: counts hits; behaviour is a function (req, res) or a status.
async function vendor(behaviour) {
  const server = http.createServer((req, res) => {
    server.hits++;
    req.resume();
    req.on('end', () => behaviour(req, res));
  });
  server.hits = 0;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.url = `http://127.0.0.1:${server.address().port}/mock`;
  server.stop = () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); });
  return server;
}
const ok = (n = 0.95) => (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ answers: { decision: { noul: n } } })); };
const status = (code, body) => (req, res) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body || '{}'); };
const hang = () => () => { /* never answers */ };

const Q = { type: 'noul', instructions: 'x', criteria: { true: 't', false: 'f' } };

// Primary typesafe, fallback vercel; both keys present.
async function scenario({ primary, fallback, cfg, env }, fn) {
  const h = makeHome();
  const p = await vendor(primary);
  const f = await vendor(fallback || ok());
  try {
    h.writeState('jev.json', Object.assign({ enabled: true, transport: 'typesafe', fallbackTransport: 'vercel', timeoutMs: 1500 }, cfg));
    await withEnv(Object.assign({
      HOME: h.home,
      CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY: 'prim' + 'ary-key',
      CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY: 'fall' + 'back-key',
      ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE: p.url,
      ANTIHALL_JEV_TEST_ENDPOINT_VERCEL: f.url,
    }, env), () => fn({ p, f, home: h.home }));
  } finally {
    await p.stop(); await f.stop(); h.cleanup();
  }
}

for (const [label, handler] of [['500', status(500)], ['503', status(503)], ['529', status(529)], ['402', status(402, '{"error_type":"insufficient_funds"}')], ['429', status(429)]]) {
  test(`primary HTTP ${label} -> served by the fallback`, async () => {
    await scenario({ primary: handler }, async ({ p, f }) => {
      const r = await fresh('jev-client.js').jevDecide({ question: Q, state: 's' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.fellBack, true);
      assert.strictEqual(r.transport, 'vercel');
      assert.strictEqual(p.hits, 1);
      assert.strictEqual(f.hits, 1);
    });
  });
}

test('primary timeout -> fallback answers inside the same total budget', async () => {
  await scenario({ primary: hang() }, async ({ f }) => {
    const t0 = Date.now();
    const r = await fresh('jev-client.js').jevDecide({ question: Q, state: 's', timeoutMs: 1000 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fellBack, true);
    assert.strictEqual(f.hits, 1);
    assert.ok(Date.now() - t0 < 1000 + 150, 'never longer than the caller budget (+ scheduling slack)');
  });
});

test('primary network error (connection refused) -> fallback', async () => {
  await scenario({ primary: ok() }, async ({ f }) => {
    process.env.ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE = 'http://127.0.0.1:1/closed';
    const r = await fresh('jev-client.js').jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.fellBack, true);
    assert.strictEqual(f.hits, 1);
  });
});

for (const [label, handler] of [['401', status(401)], ['403', status(403, '{"message":"forbidden"}')], ['404', status(404)], ['422', status(422, '{"detail":[{"input":"SECRET-STATE"}]}')], ['400', status(400, '{"message":"bad request"}')]]) {
  test(`primary HTTP ${label} -> NO fallback, the primary error surfaces`, async () => {
    await scenario({ primary: handler }, async ({ p, f }) => {
      const r = await fresh('jev-client.js').jevDecide({ question: Q, state: 's' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, `http-${label}`);
      assert.strictEqual(r.transport, 'typesafe');
      assert.strictEqual(f.hits, 0);
      assert.strictEqual(p.hits, 1);
      assert.ok(!JSON.stringify(r).includes('SECRET-STATE'), 'an error body is never returned');
    });
  });
}

test('primary 400/403 whose body names insufficient balance IS eligible', async () => {
  await scenario({ primary: status(403, '{"message":"Insufficient credits"}') }, async ({ f }) => {
    const r = await fresh('jev-client.js').jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.fellBack, true);
    assert.strictEqual(f.hits, 1);
  });
});

test('no fallback key -> the primary error surfaces and the fallback is never contacted', async () => {
  await scenario({ primary: status(500), env: { CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY: '' } }, async ({ f }) => {
    const r = await fresh('jev-client.js').jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'http-500');
    assert.strictEqual(f.hits, 0);
  });
});

test('fallbackTransport none (default) and fallback == primary both behave as none', async () => {
  for (const fb of ['none', 'typesafe', undefined, 'bogus']) {
    await scenario({ primary: status(500), cfg: { fallbackTransport: fb } }, async ({ f }) => {
      const lib = fresh('jev-client.js');
      assert.strictEqual(lib.loadJevConfig().fallbackTransport, 'none');
      const r = await lib.jevDecide({ question: Q, state: 's' });
      assert.strictEqual(r.reason, 'http-500');
      assert.strictEqual(f.hits, 0);
    });
  }
});

test('both vendors failing reports the PRIMARY reason (+ fallbackReason), one retry only', async () => {
  await scenario({ primary: status(500), fallback: status(503) }, async ({ p, f }) => {
    const r = await fresh('jev-client.js').jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'http-500');
    assert.strictEqual(r.fallbackReason, 'http-503');
    assert.strictEqual(p.hits, 1);
    assert.strictEqual(f.hits, 1);
  });
});

test('jevDecideMulti falls back too', async () => {
  await scenario({ primary: status(500) }, async ({ f }) => {
    const multi = (req, res) => { res.writeHead(200); res.end(JSON.stringify({ answers: { a: { noul: 0.9 } } })); };
    f.removeAllListeners('request');
    f.on('request', (req, res) => { f.hits++; req.resume(); req.on('end', () => multi(req, res)); });
    const r = await fresh('jev-client.js').jevDecideMulti({ questions: { a: Q }, state: 's' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fellBack, true);
    assert.strictEqual(r.answers.a.answer, true);
  });
});

test('budget exhausted -> the fallback is skipped (primary reason, fallback never contacted)', async () => {
  await scenario({ primary: hang() }, async ({ f }) => {
    const r = await fresh('jev-client.js').jevDecide({ question: Q, state: 's', timeoutMs: 200 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'timeout');
    assert.strictEqual(f.hits, 0);
  });
});

test('circuit breaker: opens after 3 eligible failures, skips the primary, probes after the cooldown', async () => {
  await scenario({ primary: status(500) }, async ({ p, f, home }) => {
    const lib = fresh('jev-client.js');
    for (let i = 0; i < 3; i++) await lib.jevDecide({ question: Q, state: 's' });
    assert.strictEqual(p.hits, 3);
    // open: the 4th call never touches the primary and gets the full budget
    const r4 = await lib.jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r4.fellBack, true);
    assert.strictEqual(p.hits, 3, 'primary skipped while the breaker is open');
    assert.strictEqual(f.hits, 4);
    // cooldown elapsed (state file aged) -> one probe of the primary
    const file = path.join(home, '.anti-hall', 'cache', 'jev-breaker.json');
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(st.typesafe.fails, 3);
    assert.strictEqual(st.vercel, undefined, 'a healthy fallback is not tracked');
    st.typesafe.openUntil = Date.now() - 1;
    fs.writeFileSync(file, JSON.stringify(st));
    await lib.jevDecide({ question: Q, state: 's' });
    assert.strictEqual(p.hits, 4, 'probed once after the cooldown');
    // the probe failed -> re-opened immediately
    await lib.jevDecide({ question: Q, state: 's' });
    assert.strictEqual(p.hits, 4);
  });
});

test('circuit breaker: a successful primary call closes it; a corrupt state file fails open', async () => {
  await scenario({ primary: ok() }, async ({ p, home }) => {
    const file = path.join(home, '.anti-hall', 'cache', 'jev-breaker.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const lib = fresh('jev-client.js');
    const r = await lib.jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fellBack, undefined);
    assert.strictEqual(r.transport, 'typesafe');
    assert.strictEqual(p.hits, 1);
  });
});

test('401 does not count toward the breaker', async () => {
  await scenario({ primary: status(401) }, async ({ p, home }) => {
    const lib = fresh('jev-client.js');
    for (let i = 0; i < 4; i++) await lib.jevDecide({ question: Q, state: 's' });
    assert.strictEqual(p.hits, 4);
    assert.ok(!fs.existsSync(path.join(home, '.anti-hall', 'cache', 'jev-breaker.json')));
  });
});

test('endpoint overrides stay loopback-only for the fallback transport too', async () => {
  await withEnv({ ANTIHALL_JEV_TEST_ENDPOINT_VERCEL: 'https://evil.example/x', ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE: 'http://127.0.0.1:9/y' }, async () => {
    const cfg = fresh('jev-client.js').loadJevConfig();
    assert.strictEqual(cfg.endpointOverrides.vercel, null);
    assert.strictEqual(cfg.endpointOverrides.typesafe, 'http://127.0.0.1:9/y');
  });
});

test('the fallback key is sent only to the fallback vendor, the primary key only to the primary', async () => {
  const seen = {};
  const spy = (name) => (req, res) => { seen[name] = req.headers.authorization; status(500)(req, res); };
  await scenario({ primary: spy('p'), fallback: (req, res) => { seen.f = req.headers.authorization; ok()(req, res); } }, async () => {
    await fresh('jev-client.js').jevDecide({ question: Q, state: 's' });
    assert.strictEqual(seen.p, 'Bearer primary-key');
    assert.strictEqual(seen.f, 'Bearer fallback-key');
  });
});

test('legacy key-file route: each transport reads its OWN key file', async () => {
  const h = makeHome();
  const seen = {};
  const p = await vendor((req, res) => { seen.p = req.headers.authorization; status(500)(req, res); });
  const f = await vendor((req, res) => { seen.f = req.headers.authorization; ok()(req, res); });
  try {
    h.writeState('jev.json', { enabled: true, transport: 'typesafe', fallbackTransport: 'vercel' });
    h.writeState('settings.json', { jev: { allowLegacyKeyRead: true } });
    fs.mkdirSync(path.join(h.home, '.config', 'typesafe'), { recursive: true });
    fs.mkdirSync(path.join(h.home, '.config', 'vercel'), { recursive: true });
    fs.writeFileSync(path.join(h.home, '.config', 'typesafe', 'key'), 'ts-file-key\n');
    fs.writeFileSync(path.join(h.home, '.config', 'vercel', 'ai-gateway-key'), 'vc-file-key\n');
    await withEnv({ HOME: h.home, ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE: p.url, ANTIHALL_JEV_TEST_ENDPOINT_VERCEL: f.url }, async () => {
      const r = await fresh('jev-client.js').jevDecide({ question: Q, state: 's' });
      assert.strictEqual(r.fellBack, true);
      assert.strictEqual(seen.p, 'Bearer ts-file-key');
      assert.strictEqual(seen.f, 'Bearer vc-file-key');
    });
  } finally { await p.stop(); await f.stop(); h.cleanup(); }
});

test('decision log + rollup record transport and fellBack', async () => {
  await scenario({ primary: status(500), cfg: { integrations: { speculation: 'on' } } }, async ({ home }) => {
    const lib = fresh('jev-assist.js');
    const r = await lib.ask({ id: 'speculation', question: Q, state: 'hello', trust: 'add-block', baseline: false });
    assert.strictEqual(r.backend, 'jev');
    const rows = fs.readFileSync(path.join(home, '.anti-hall', 'logs', 'jev-assist.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].transport, 'vercel');
    assert.strictEqual(rows[0].fellBack, true);
    const day = lib.buildDailyRollups(rows).values().next().value;
    assert.strictEqual(day.transports.vercel, 1);
    assert.strictEqual(day.groups[0].fellBack, 1);
  });
});

test('breaker covers the both-fail case: primary AND fallback open -> Jev skipped entirely, then both probed after the cooldown', async () => {
  await scenario({ primary: status(500), fallback: status(503) }, async ({ p, f, home }) => {
    const lib = fresh('jev-client.js');
    for (let i = 0; i < 3; i++) await lib.jevDecide({ question: Q, state: 's' });
    assert.strictEqual(p.hits, 3);
    assert.strictEqual(f.hits, 3);
    const t0 = Date.now();
    const r = await lib.jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'circuit-open');
    assert.strictEqual(p.hits, 3, 'no request to either vendor while both are open');
    assert.strictEqual(f.hits, 3);
    assert.ok(Date.now() - t0 < 100, 'no timeouts paid');
    const file = path.join(home, '.anti-hall', 'cache', 'jev-breaker.json');
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    st.typesafe.openUntil = Date.now() - 1; st.vercel.openUntil = Date.now() - 1;
    fs.writeFileSync(file, JSON.stringify(st));
    await lib.jevDecide({ question: Q, state: 's' });
    assert.strictEqual(p.hits, 4);
    assert.strictEqual(f.hits, 4);
  });
});

test('breaker: an open fallback is not tried (primary gets the full budget); primary still counts', async () => {
  await scenario({ primary: status(500) }, async ({ p, f, home }) => {
    const file = path.join(home, '.anti-hall', 'cache', 'jev-breaker.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ vercel: { fails: 3, openUntil: Date.now() + 60000 } }));
    const r = await fresh('jev-client.js').jevDecide({ question: Q, state: 's' });
    assert.strictEqual(r.reason, 'http-500');
    assert.strictEqual(p.hits, 1);
    assert.strictEqual(f.hits, 0);
  });
});
