'use strict';
// Both transports (vercel, typesafe) through the whole tracking loop:
// decision -> log row -> daily rollup -> report line, in on and shadow modes.
// Response fixtures are the REAL shapes measured live (2026-10-02): typesafe
// direct = {model:'jev-1.13.0', answers, usage}; the vercel passthrough adds
// provider_metadata.gateway.{cost (string), generationId, routing}. Neither
// returns a confidence field (client derives it from noul).

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeHome } = require('../helpers/fixtures.js');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const HOOKS = path.join(PLUGIN, 'hooks', 'lib');
const REPORT = path.join(PLUGIN, 'scripts', 'jev-report.js');
const LIBS = ['jev-client.js', 'jev-assist.js'].map((f) => require.resolve(path.join(HOOKS, f)));
const fresh = (n) => { for (const l of LIBS) delete require.cache[l]; return require(path.join(HOOKS, n)); };

const RESPONSES = {
  typesafe: { model: 'jev-1.13.0', answers: { decision: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 497, output_tokens: 20 } },
  vercel: {
    model: 'typesafe-ai/jev', answers: { decision: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 497, output_tokens: 20 },
    provider_metadata: { typesafe: { confidence: {} }, gateway: { routing: { finalProvider: 'typesafe-ai' }, cost: '0.000020874', marketCost: '0.000020874', gatewayCost: '0.000020874', generationId: 'gen_x' } },
  },
};
const MODELS = { typesafe: 'jev-latest', vercel: 'typesafe-ai/jev' };
const Q = { type: 'noul', instructions: 'x', criteria: { true: 't', false: 'f' } };
const ENV_KEYS = ['HOME', 'ANTIHALL_JEV', 'CLAUDE_PLUGIN_OPTION_JEV_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY', 'ANTIHALL_JEV_TEST_ENDPOINT', 'ANTIHALL_JEV_TEST_ENDPOINT_VERCEL', 'ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE'];
async function withEnv(o, fn) {
  const saved = {}; for (const k of ENV_KEYS) saved[k] = process.env[k];
  try { for (const k of ENV_KEYS) delete process.env[k]; Object.assign(process.env, o); return await fn(); }
  finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
async function run(transport, mode, fn) {
  const h = makeHome();
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { bodies.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(RESPONSES[transport])); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    h.writeState('jev.json', { enabled: true, transport, timeoutMs: 3000, integrations: { speculation: mode } });
    await withEnv({
      HOME: h.home, ['CLAUDE_PLUGIN_OPTION_JEV_' + transport.toUpperCase() + '_API_KEY']: 'k',
      ['ANTIHALL_JEV_TEST_ENDPOINT_' + transport.toUpperCase()]: `http://127.0.0.1:${server.address().port}/m`,
    }, () => fn({ home: h.home, bodies }));
  } finally { await new Promise((r) => server.close(r)); h.cleanup(); }
}

for (const transport of ['vercel', 'typesafe']) {
  test(`[${transport}] client: request model, parsed answer, derived confidence, tokens, model, cost`, async () => {
    await run(transport, 'on', async ({ bodies }) => {
      const r = await fresh('jev-client.js').jevDecide({ question: Q, state: 'hello' });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.answer, true);
      assert.ok(Math.abs(r.confidence - 0.94) < 1e-9, 'confidence = |noul-0.5|*2 on both vendors');
      assert.strictEqual(r.transport, transport);
      assert.strictEqual(r.fellBack, undefined);
      assert.strictEqual(bodies[0].model, MODELS[transport]);
      assert.strictEqual(r.tokensIn, 497);
      assert.strictEqual(r.tokensOut, 20);
      assert.strictEqual(r.model, RESPONSES[transport].model);
      // real per-request cost only on vercel (provider_metadata.gateway.cost); typesafe has none
      assert.strictEqual(r.cost, transport === 'vercel' ? 0.000020874 : null);
    });
  });

  for (const mode of ['on', 'shadow']) {
    test(`[${transport}] ${mode} mode: decision -> log row -> rollup -> report line`, async () => {
      await run(transport, mode, async ({ home }) => {
        const a = fresh('jev-assist.js');
        const r = await a.ask({ id: 'speculation', question: Q, state: 'hello there', trust: 'add-block', baseline: false });
        assert.strictEqual(r.backend, 'jev');
        // on: Jev's confident true adds the block; shadow: never changes the outcome
        assert.strictEqual(r.final, mode === 'on');

        const rows = fs.readFileSync(path.join(home, '.anti-hall', 'logs', 'jev-assist.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].transport, transport);
        assert.strictEqual(rows[0].mode, mode);
        assert.strictEqual(rows[0].fellBack, undefined);
        assert.strictEqual(rows[0].costSource, transport === 'vercel' ? 'gateway' : 'default-price');
        assert.ok(rows[0].costUsd > 0);

        const day = a.buildDailyRollups(rows).values().next().value;
        assert.deepStrictEqual(day.transports, { [transport]: 1 });
        assert.strictEqual(day.groups[0].fellBack, 0);

        const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ANTIHALL_INGEST_DRY_RUN: '1' });
        for (const k of ENV_KEYS) if (k !== 'HOME') delete env[k];
        const out = execFileSync(process.execPath, [REPORT], { env, encoding: 'utf8' });
        assert.match(out, new RegExp(`by transport[^\\n]*\\n\\s+${transport}: 1 call\\(s\\), 0 error\\(s\\), avg \\d+ms, 0 fell back`));
        const json = JSON.parse(execFileSync(process.execPath, [REPORT, '--json'], { env, encoding: 'utf8' }));
        assert.deepStrictEqual(json.transports.map((t) => [t.transport, t.calls]), [[transport, 1]]);
      });
    });
  }
}

test('report: rows without a transport land in "unrecorded (assumed vercel)", never merged into vercel', () => {
  const { buildTransportBreakdown } = require(path.join(PLUGIN, 'scripts', 'jev-report.js'));
  const base = { ts: new Date().toISOString(), id: 'speculation', backend: 'jev', ms: 100, mode: 'on' };
  const rows = [
    Object.assign({}, base),
    Object.assign({}, base, { transport: 'vercel', ms: 300 }),
    Object.assign({}, base, { transport: 'typesafe', ms: 200, fellBack: true }),
    Object.assign({}, base, { transport: 'typesafe', backend: 'baseline-only', reason: 'http-500', ms: 50 }),
    Object.assign({}, base, { backend: 'cache' }),
    Object.assign({}, base, { backend: 'baseline-only' }), // skipped: no call
  ];
  const t = Object.fromEntries(buildTransportBreakdown(rows, [], null).map((x) => [x.transport, x]));
  assert.deepStrictEqual(Object.keys(t).sort(), ['typesafe', 'unrecorded', 'vercel']);
  assert.strictEqual(t.unrecorded.calls, 1);
  assert.strictEqual(t.vercel.avgMs, 300);
  assert.strictEqual(t.typesafe.calls, 2);
  assert.strictEqual(t.typesafe.errors, 1);
  assert.strictEqual(t.typesafe.fellBack, 1);
  assert.strictEqual(t.typesafe.avgMs, 200, 'avg over successful calls only');
});

test('triage rows carry the serving transport into the breakdown', () => {
  const { buildTransportBreakdown } = require(path.join(PLUGIN, 'scripts', 'jev-report.js'));
  const t = buildTransportBreakdown([], [
    { ts: new Date().toISOString(), hash: 'a', backend: 'jev', ms: 120, transport: 'typesafe' },
    { ts: new Date().toISOString(), hash: 'b', backend: 'haiku', ms: 900 },
    { ts: new Date().toISOString(), type: 'answered', latencyMs: 5 },
  ], null);
  assert.deepStrictEqual(t.map((x) => [x.transport, x.calls]), [['typesafe', 1]]);
});

test('no error path returns or logs a response body (typesafe 422 echoes the submitted state)', async () => {
  const h = makeHome();
  const echo = 'SECRET-STATE-ECHO';
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(422, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ detail: [{ type: 'missing', input: echo }] })); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    h.writeState('jev.json', { enabled: true, transport: 'typesafe', integrations: { speculation: 'on' } });
    await withEnv({ HOME: h.home, CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE: `http://127.0.0.1:${server.address().port}/m` }, async () => {
      const r = await fresh('jev-client.js').jevDecide({ question: Q, state: echo });
      assert.strictEqual(r.reason, 'http-422');
      assert.ok(!JSON.stringify(r).includes(echo));
      const a = fresh('jev-assist.js');
      await a.ask({ id: 'speculation', question: Q, state: echo, trust: 'add-block', baseline: false });
    });
    const logDir = path.join(h.home, '.anti-hall');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(logDir)) {
      if (/settings|jev\.json/.test(f)) continue;
      assert.ok(!fs.readFileSync(f, 'utf8').includes(echo), `${f} must not contain the echoed state`);
    }
  } finally { await new Promise((r) => server.close(r)); h.cleanup(); }
});

test('weekly scorecard carries the per-transport breakdown', () => {
  const { buildWeeklyScorecard } = require(path.join(PLUGIN, 'scripts', 'jev-report.js'));
  const row = { ts: new Date().toISOString(), id: 'speculation', hash: 'h', backend: 'jev', ms: 80, mode: 'on', transport: 'typesafe' };
  const sc = buildWeeklyScorecard([row], {});
  assert.deepStrictEqual(sc.transports.map((t) => [t.transport, t.calls]), [['typesafe', 1]]);
});
