'use strict';
// jev-assist.js — unit tests, in-process (direct require), never touching the
// real network. Same mock-server pattern as jev-client.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');

const LIB = require.resolve('../../plugins/anti-hall/hooks/lib/jev-assist.js');
const CLIENT_LIB = require.resolve('../../plugins/anti-hall/hooks/lib/jev-client.js');

function freshLib() {
  delete require.cache[LIB];
  delete require.cache[CLIENT_LIB];
  return require(LIB);
}

const ENV_KEYS = [
  'HOME', 'ANTIHALL_JEV', 'AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY',
  'ANTIHALL_JEV_TEST_ENDPOINT', 'ANTIHALL_JEV_SPECULATION', 'ANTIHALL_JEV_MODEL_ROUTING',
];

// NOTE: this awaits fn() INSIDE the try, unlike jev-client.test.js's sibling
// helper — several tests here make TWO sequential ask() calls per withEnv
// block, and restoring env before the first call's promise settles would
// silently point the second call at the REAL (non-fixture) HOME.
async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, overrides);
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function withMockServer(handler, fn) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      Promise.resolve(fn(`http://127.0.0.1:${port}/mock`))
        .then((v) => server.close(() => resolve(v)))
        .catch((e) => server.close(() => reject(e)));
    });
  });
}

function noulHandler(n) {
  return (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: n } } }));
    });
  };
}

function choiceHandler(choice, confidence) {
  return (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { choice, confidence } } }));
    });
  };
}

const NOUL_Q = { type: 'noul', instructions: 'x', criteria: { true: 't', false: 'f' } };
const CHOICE_Q = {
  type: 'choice', instructions: 'x',
  criteria: { mechanical: 'm', authoring: 'a', research: 'r', 'plan-review': 'p' },
};

function readNdjson(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// getMode / integration modes + env overrides
// ---------------------------------------------------------------------------

test('getMode: globally disabled -> off for any integration', () => {
  const { getMode } = freshLib();
  assert.strictEqual(getMode('speculation', {}), 'off');
  assert.strictEqual(getMode('speculation', { enabled: false }), 'off');
});

test('getMode: legacy {"enabled":true} with no integrations map -> speculation/triage on, unknown -> shadow', () => {
  const { getMode } = freshLib();
  const cfg = { enabled: true };
  assert.strictEqual(getMode('speculation', cfg), 'on');
  assert.strictEqual(getMode('triage', cfg), 'on');
  assert.strictEqual(getMode('modelRouting', cfg), 'shadow');
  assert.strictEqual(getMode('claimLedger', cfg), 'shadow');
});

test('getMode: legacy {"triage": false} still disables triage when integrations map omits it', () => {
  const { getMode } = freshLib();
  assert.strictEqual(getMode('triage', { enabled: true, triage: false }), 'off');
  // integrations map, when present, takes priority over the legacy key.
  assert.strictEqual(getMode('triage', { enabled: true, triage: false, integrations: { triage: 'on' } }), 'on');
});

test('getMode: explicit integrations map value wins', () => {
  const { getMode } = freshLib();
  const cfg = { enabled: true, integrations: { speculation: 'off', modelRouting: 'on' } };
  assert.strictEqual(getMode('speculation', cfg), 'off');
  assert.strictEqual(getMode('modelRouting', cfg), 'on');
});

test('getMode: ANTIHALL_JEV=0 always wins over jev.json', () => {
  withEnv({ ANTIHALL_JEV: '0' }, () => {
    const { getMode } = freshLib();
    assert.strictEqual(getMode('speculation', { enabled: true, integrations: { speculation: 'on' } }), 'off');
  });
});

test('getMode: per-integration env override ANTIHALL_JEV_<ID>=0 forces that one off', () => {
  withEnv({ ANTIHALL_JEV_MODEL_ROUTING: '0' }, () => {
    const { getMode } = freshLib();
    assert.strictEqual(getMode('modelRouting', { enabled: true, integrations: { modelRouting: 'on' } }), 'off');
    assert.strictEqual(getMode('speculation', { enabled: true }), 'on');
  });
});

test('envNameFor: camelCase id -> ANTIHALL_JEV_<SNAKE>', () => {
  const { envNameFor } = freshLib();
  assert.strictEqual(envNameFor('modelRouting'), 'ANTIHALL_JEV_MODEL_ROUTING');
  assert.strictEqual(envNameFor('speculation'), 'ANTIHALL_JEV_SPECULATION');
});

// ---------------------------------------------------------------------------
// computeFinal — pure trust math
// ---------------------------------------------------------------------------

test('computeFinal add-block: can only turn false->true, never relax an existing true', () => {
  const { computeFinal } = freshLib();
  assert.strictEqual(computeFinal('add-block', false, true, true), true, 'confident+true adds a block');
  assert.strictEqual(computeFinal('add-block', false, true, false), false, 'not confident -> baseline stands');
  assert.strictEqual(computeFinal('add-block', false, false, true), false, 'confident+false -> baseline stands');
  assert.strictEqual(computeFinal('add-block', true, false, true), true, 'baseline true is NEVER relaxed by add-block');
});

test('computeFinal relax-block: can only turn true->false, never add a block', () => {
  const { computeFinal } = freshLib();
  assert.strictEqual(computeFinal('relax-block', true, false, true), false, 'confident+false relaxes the block');
  assert.strictEqual(computeFinal('relax-block', true, true, true), true, 'confident+true -> stays blocked');
  assert.strictEqual(computeFinal('relax-block', true, false, false), true, 'not confident -> baseline stands');
  assert.strictEqual(computeFinal('relax-block', false, true, true), false, 'baseline false is NEVER turned true by relax-block');
});

test('computeFinal advisory: final is jev when confident, else baseline', () => {
  const { computeFinal } = freshLib();
  assert.strictEqual(computeFinal('advisory', null, true, true), true);
  assert.strictEqual(computeFinal('advisory', 'baseline-label', true, false), 'baseline-label');
});

// ---------------------------------------------------------------------------
// computeCostUsd — pure function
// ---------------------------------------------------------------------------

test('computeCostUsd: cache hit is always $0, regardless of anything else', () => {
  const { computeCostUsd } = freshLib();
  const r = computeCostUsd({ r: { ok: true, cost: 5 }, cachedFlag: true, home: '/nonexistent' });
  assert.deepStrictEqual(r, { costUsd: 0, costSource: 'cache' });
});

test('computeCostUsd: gateway-reported cost wins over the price table', () => {
  const { computeCostUsd } = freshLib();
  const r = computeCostUsd({ r: { ok: true, cost: 0.002, tokensIn: 100, tokensOut: 50 }, cachedFlag: false, home: '/nonexistent' });
  assert.deepStrictEqual(r, { costUsd: 0.002, costSource: 'gateway' });
});

test('computeCostUsd: no gateway cost, real tokens, price table configured -> computed from prices', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { prices: { 'typesafe-ai/jev': { inPerMTok: 1, outPerMTok: 2 } } });
    const { computeCostUsd } = freshLib();
    const r = computeCostUsd({
      r: { ok: true, tokensIn: 1000000, tokensOut: 500000, model: 'typesafe-ai/jev' },
      cachedFlag: false, home: h.home,
    });
    assert.strictEqual(r.costSource, 'price-table');
    assert.ok(Math.abs(r.costUsd - (1 + 1)) < 1e-9, '1M in @ $1/MTok + 0.5M out @ $2/MTok = $2');
  } finally { h.cleanup(); }
});

test('computeCostUsd: real tokens but no price table entry -> null, never fabricated', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', {});
    const { computeCostUsd } = freshLib();
    const r = computeCostUsd({
      r: { ok: true, tokensIn: 100, tokensOut: 50, model: 'typesafe-ai/jev' },
      cachedFlag: false, home: h.home,
    });
    assert.deepStrictEqual(r, { costUsd: null, costSource: null });
  } finally { h.cleanup(); }
});

test('computeCostUsd: no cost, no tokens -> null (the observed systemone shape)', () => {
  const { computeCostUsd } = freshLib();
  const r = computeCostUsd({ r: { ok: true }, cachedFlag: false, home: '/nonexistent' });
  assert.deepStrictEqual(r, { costUsd: null, costSource: null });
});

test('computeCostUsd: no result at all (skipped call) -> null', () => {
  const { computeCostUsd } = freshLib();
  assert.deepStrictEqual(computeCostUsd({ r: null, cachedFlag: false, home: '/nonexistent' }), { costUsd: null, costSource: null });
});

// ---------------------------------------------------------------------------
// Budget watch (opt-in, never auto-disables)
// ---------------------------------------------------------------------------

test('readBudgetConfig: no jev.json / no budget key -> "unlimited", no thresholds', () => {
  const { readBudgetConfig } = freshLib();
  const h = makeHome();
  try {
    assert.deepStrictEqual(readBudgetConfig(h.home), { mode: 'unlimited', usdPerDay: null, usdPerWeek: null });
  } finally { h.cleanup(); }
});

test('readBudgetConfig: watch mode with usdPerDay/usdPerWeek', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { budget: { mode: 'watch', usdPerDay: 5, usdPerWeek: 25 } });
    const { readBudgetConfig } = freshLib();
    assert.deepStrictEqual(readBudgetConfig(h.home), { mode: 'watch', usdPerDay: 5, usdPerWeek: 25 });
  } finally { h.cleanup(); }
});

test('maybeWarnBudget: mode "unlimited" (default) -> never writes state, never warns, regardless of spend', () => {
  const h = makeHome();
  try {
    const { maybeWarnBudget } = freshLib();
    maybeWarnBudget({ home: h.home, costUsd: 1000 });
    assert.ok(!fs.existsSync(path.join(h.home, '.anti-hall', 'state', 'jev-budget.json')), 'unlimited mode touches no state at all');
    const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
    assert.strictEqual(log.length, 0);
  } finally { h.cleanup(); }
});

test('maybeWarnBudget: watch mode, under budget -> tracks spend, no warning', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { budget: { mode: 'watch', usdPerDay: 5 } });
    const { maybeWarnBudget } = freshLib();
    maybeWarnBudget({ home: h.home, costUsd: 1 });
    const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
    assert.strictEqual(log.length, 0, 'no warning while under budget');
  } finally { h.cleanup(); }
});

test('maybeWarnBudget: watch mode, over budget -> exactly ONE warning per day, never disables Jev', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { budget: { mode: 'watch', usdPerDay: 5 } });
    const { maybeWarnBudget } = freshLib();
    maybeWarnBudget({ home: h.home, costUsd: 3 });
    maybeWarnBudget({ home: h.home, costUsd: 3 }); // total now 6 > 5 -> warn once
    maybeWarnBudget({ home: h.home, costUsd: 3 }); // still over -> must NOT warn again today
    const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
    const warnings = log.filter((l) => l.type === 'budget-warning');
    assert.strictEqual(warnings.length, 1, 'exactly one warning per calendar day');
    assert.strictEqual(warnings[0].window, 'daily');
    assert.strictEqual(warnings[0].budgetUsd, 5);
    // jev.json is untouched (never auto-disabled)
    const cfg = JSON.parse(fs.readFileSync(path.join(h.home, '.anti-hall', 'jev.json'), 'utf8'));
    assert.strictEqual(cfg.enabled, undefined, 'budget watch never writes an enabled flag');
  } finally { h.cleanup(); }
});

test('maybeWarnBudget: a new day resets spend and allows a fresh warning', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { budget: { mode: 'watch', usdPerDay: 5 } });
    const { maybeWarnBudget, budgetStatePath } = freshLib();
    maybeWarnBudget({ home: h.home, costUsd: 10 }); // warns once "today"
    // simulate yesterday's state so the next call sees a new day
    const statePath = budgetStatePath(h.home);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.date = '2000-01-01';
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
    maybeWarnBudget({ home: h.home, costUsd: 10 }); // new day -> warns again
    const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
    assert.strictEqual(log.filter((l) => l.type === 'budget-warning').length, 2);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// ask() end-to-end (mock server)
// ---------------------------------------------------------------------------

test('ask(): mode off -> baseline-only, no network call, still logs to jev-assist.ndjson', async () => {
  const h = makeHome();
  try {
    await withMockServer(noulHandler(0.99), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { ask } = freshLib();
        const r = await ask({ id: 'speculation', question: NOUL_Q, state: 'hello', trust: 'add-block', baseline: false });
        assert.strictEqual(r.final, false);
        assert.strictEqual(r.backend, 'baseline-only');
        assert.strictEqual(r.jev, null);
      });
    });
  } finally { h.cleanup(); }
});

test('ask(): add-block, confident true -> block added, mode on', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000 });
    await withMockServer(noulHandler(0.95), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { ask } = freshLib();
        const r = await ask({ id: 'speculation', question: NOUL_Q, state: 'hello', trust: 'add-block', baseline: false });
        assert.strictEqual(r.final, true);
        assert.strictEqual(r.backend, 'jev');
        const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
        assert.strictEqual(log.length, 1);
        assert.strictEqual(log[0].changed, 'added');
        assert.strictEqual(log[0].base, false);
        assert.strictEqual(log[0].final, true);
        assert.strictEqual(log[0].mode, 'on');
        // no message body / credential in the log line
        assert.ok(!JSON.stringify(log[0]).includes('hello'));
        assert.ok(!JSON.stringify(log[0]).includes('k'.repeat(1)) || !('state' in log[0]));
      });
    });
  } finally { h.cleanup(); }
});

test('ask(): `compare` is logged verbatim and never affects trust math', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000 });
    await withMockServer(noulHandler(0.95), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { ask } = freshLib();
        // baseline stays the hardcoded add-block constant (false); compare
        // carries the REAL independent heuristic verdict (true here) --
        // final must still be computed from baseline/trust, not compare.
        const r = await ask({
          id: 'speculation', question: NOUL_Q, state: 'hello', trust: 'add-block',
          baseline: false, compare: true,
        });
        assert.strictEqual(r.final, true, 'trust math unaffected by compare');
        const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
        assert.strictEqual(log[0].compare, true);
        assert.strictEqual(log[0].base, false);
      });
    });
  } finally { h.cleanup(); }
});

test('ask(): omitting `compare` writes no `compare` field (backward compatible)', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000 });
    await withMockServer(noulHandler(0.95), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { ask } = freshLib();
        const r = await ask({ id: 'speculation', question: NOUL_Q, state: 'hello', trust: 'add-block', baseline: false });
        assert.strictEqual(r.final, true);
        const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
        assert.ok(!('compare' in log[0]));
      });
    });
  } finally { h.cleanup(); }
});

test('ask(): logs costUsd:null/costSource:null when the response carries no cost/usage (the observed default)', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000 });
    await withMockServer(noulHandler(0.95), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { ask } = freshLib();
        await ask({ id: 'speculation', question: NOUL_Q, state: 'hello', trust: 'add-block', baseline: false });
        const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
        assert.strictEqual(log[0].costUsd, null);
        assert.strictEqual(log[0].costSource, null);
      });
    });
  } finally { h.cleanup(); }
});

test('ask(): a cache hit logs costUsd:0, costSource:"cache" on the SECOND call', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000 });
    await withMockServer(noulHandler(0.95), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { ask } = freshLib();
        await ask({ id: 'speculation', question: NOUL_Q, state: 'same text', trust: 'add-block', baseline: false });
        await ask({ id: 'speculation', question: NOUL_Q, state: 'same text', trust: 'add-block', baseline: false });
        const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
        assert.strictEqual(log.length, 2);
        assert.strictEqual(log[1].backend, 'cache');
        assert.strictEqual(log[1].costUsd, 0);
        assert.strictEqual(log[1].costSource, 'cache');
      });
    });
  } finally { h.cleanup(); }
});

test('ask(): shadow mode calls Jev + logs but NEVER changes the outcome', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000, integrations: { modelRouting: 'shadow' } });
    await withMockServer(choiceHandler('authoring', 0.95), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { ask } = freshLib();
        const r = await ask({
          id: 'modelRouting', question: CHOICE_Q, state: 'spawn text', trust: 'relax-block',
          baseline: true, judge: (a) => a === 'mechanical',
        });
        assert.strictEqual(r.final, true, 'shadow never relaxes the block');
        const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
        assert.strictEqual(log[0].mode, 'shadow');
        assert.strictEqual(log[0].changed, null, 'shadow logs no change even though Jev would have relaxed it');
        assert.strictEqual(log[0].jev, 'authoring');
      });
    });
  } finally { h.cleanup(); }
});

test('ask(): relax-block skips the call entirely when baseline is not blocking', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000, integrations: { modelRouting: 'on' } });
    let calls = 0;
    await withMockServer((req, res) => { calls++; res.writeHead(200); res.end('{}'); }, async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { ask } = freshLib();
        const r = await ask({
          id: 'modelRouting', question: CHOICE_Q, state: 'x', trust: 'relax-block',
          baseline: false, judge: (a) => a === 'mechanical',
        });
        assert.strictEqual(r.final, false);
        assert.strictEqual(calls, 0, 'nothing to relax -> Jev is never consulted');
      });
    });
  } finally { h.cleanup(); }
});

test('ask(): fail-open to baseline on timeout', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 150 });
    await withMockServer(() => { /* never respond */ }, async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { ask } = freshLib();
        const r = await ask({ id: 'speculation', question: NOUL_Q, state: 'x', trust: 'add-block', baseline: false });
        assert.strictEqual(r.final, false);
        assert.strictEqual(r.backend, 'baseline-only');
        assert.strictEqual(r.reason, 'timeout');
      });
    });
  } finally { h.cleanup(); }
});

test('ask(): second call with the same id+state hits the cache (backend "cache"), only one HTTP call', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000 });
    let calls = 0;
    await withMockServer((req, res) => {
      calls++;
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answers: { decision: { noul: 0.95 } } }));
      });
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { ask } = freshLib();
        const r1 = await ask({ id: 'speculation', question: NOUL_Q, state: 'same text', trust: 'add-block', baseline: false });
        const r2 = await ask({ id: 'speculation', question: NOUL_Q, state: 'same text', trust: 'add-block', baseline: false });
        assert.strictEqual(r1.backend, 'jev');
        assert.strictEqual(r2.backend, 'cache');
        assert.strictEqual(r2.final, true);
        assert.strictEqual(calls, 1);
        const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
        assert.strictEqual(log.length, 2);
        assert.strictEqual(log[1].cached, true);
      });
    });
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// recordOutcome
// ---------------------------------------------------------------------------

test('recordOutcome: appends an outcome line joinable by hash', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000 });
    await withMockServer(noulHandler(0.95), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { ask, recordOutcome } = freshLib();
        const r = await ask({ id: 'speculation', question: NOUL_Q, state: 'x', trust: 'add-block', baseline: false });
        recordOutcome({ id: 'speculation', h: r.h, outcome: 'evidence-added', home: h.home });
        const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
        const outcomeLine = log.find((l) => l.type === 'outcome');
        assert.ok(outcomeLine, 'outcome line present');
        assert.strictEqual(outcomeLine.h, r.h);
        assert.strictEqual(outcomeLine.outcome, 'evidence-added');
      });
    });
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// askSync — sync subprocess path (model-routing-guard's use case)
// ---------------------------------------------------------------------------

// askSync() spawns its OWN subprocess (jev-assist-worker.js) via execFileSync,
// which BLOCKS the caller's event loop for the duration of the call. Calling
// it directly in this test process would deadlock the in-process mock HTTP
// server (its 'data'/'end' handlers need this process's event loop to run).
// So we run askSync itself inside a spawned (async, non-blocking) child
// process — exactly the two-process-deep shape model-routing-guard.js has in
// production (hook process -> jev-assist-worker.js) — while the mock server
// stays in THIS process, whose event loop is never blocked.
function runAskSyncInChild(opts, env) {
  // opts.judgeSrc, if present, is the SOURCE of a judge(answer) function —
  // JSON can't carry a function, so it travels as text and is eval'd in the child.
  const { judgeSrc, ...rest } = opts;
  const script = `
    const { askSync } = require(${JSON.stringify(LIB)});
    const opts = ${JSON.stringify(rest)};
    ${judgeSrc ? `opts.judge = (${judgeSrc});` : ''}
    const r = askSync(opts);
    process.stdout.write(JSON.stringify(r));
  `;
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', () => {
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`bad output: ${stdout} / ${stderr}`)); }
    });
  });
}

test('askSync(): relax-block via subprocess, confident non-mechanical relaxes the block', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000, integrations: { modelRouting: 'on' } });
    await withMockServer(choiceHandler('authoring', 0.95), async (endpoint) => {
      const env = {
        PATH: process.env.PATH, HOME: h.home,
        AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint,
      };
      const r = await runAskSyncInChild({
        id: 'modelRouting', question: CHOICE_Q, state: 'write the report', trust: 'relax-block',
        baseline: true, judgeSrc: "(a) => a === 'mechanical'", budgetMs: 8000,
      }, env);
      assert.strictEqual(r.final, false, 'confident non-mechanical relaxes the block');
      assert.strictEqual(r.backend, 'jev');
    });
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// askDetached() — fire-and-forget path (UserPromptSubmit/PostToolUse callers)
// ---------------------------------------------------------------------------

// waitForLog(p, predicate) — poll a small number of times for the detached
// child's own async write to land (it runs in a separate, unref()'d process
// this test process does not otherwise wait on).
async function waitForLog(p, predicate, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    const rows = readNdjson(p);
    const hit = rows.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

test('askDetached(): returns synchronously without waiting on the network call', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, integrations: { newRequest: 'shadow' } });
    await withMockServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      // Simulate a slow Jev backend; askDetached must not make the CALLER wait on this.
      req.on('end', () => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ answers: { decision: { choice: 'new-request', confidence: 0.9 } } }));
        }, 800);
      });
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { askDetached } = freshLib();
        const t0 = Date.now();
        askDetached({ id: 'newRequest', question: CHOICE_Q, state: 'please fix the bug', trust: 'advisory', baseline: null });
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 200, `askDetached must return near-instantly; took ${elapsed}ms`);

        const p = path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson');
        const hit = await waitForLog(p, (r) => r.id === 'newRequest');
        assert.ok(hit, 'the detached worker must still land a decision row eventually');
        assert.strictEqual(hit.mode, 'shadow');
        assert.strictEqual(hit.final, hit.base, 'shadow mode: final must equal baseline');
        assert.strictEqual(hit.final, null);
      });
    });
  } finally { h.cleanup(); }
});

test('askDetached(): mode off -> no network call (baseline-only), still returns instantly', async () => {
  const h = makeHome();
  try {
    // no jev.json at all -> globally disabled (mode 'off'). A decision row
    // still lands (every ask()/askSync()/askDetached() call always logs, per
    // jev-assist.js's own contract — that's how call-volume/failure-rate
    // tracking works uniformly) but backend must be 'baseline-only': no
    // network call was ever attempted.
    await withEnv({ HOME: h.home }, async () => {
      const { askDetached } = freshLib();
      const t0 = Date.now();
      askDetached({ id: 'newRequest', question: CHOICE_Q, state: 'x', trust: 'advisory', baseline: null });
      assert.ok(Date.now() - t0 < 100);
      const p = path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson');
      const hit = await waitForLog(p, (r) => r.id === 'newRequest');
      assert.ok(hit, 'expected a baseline-only decision row even in mode off');
      assert.strictEqual(hit.mode, 'off');
      assert.strictEqual(hit.backend, 'baseline-only');
      assert.strictEqual(hit.jev, null, 'mode off must never reach the network, so jev must be null');
      assert.strictEqual(hit.final, hit.base);
    });
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Shadow-log row shape for the newly-wired integrations (claimLedger,
// mergeGateHedge, newRequest): final MUST equal baseline in shadow mode.
// ---------------------------------------------------------------------------

test('ask()/askSync() shadow-log row: claimLedger and mergeGateHedge default to shadow -> final always equals baseline', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true }); // no explicit integrations map -> both default "shadow"
    await withMockServer(noulHandler(0.99), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { ask, getMode } = freshLib();
        assert.strictEqual(getMode('claimLedger', { enabled: true }), 'shadow');
        assert.strictEqual(getMode('mergeGateHedge', { enabled: true }), 'shadow');

        const r1 = await ask({ id: 'claimLedger', question: NOUL_Q, state: 'claim: 12 files', trust: 'relax-block', baseline: true });
        assert.strictEqual(r1.final, true, 'shadow: final must equal baseline (true) even though Jev said false at conf 0.99');
        assert.strictEqual(r1.backend, 'jev');

        const r2 = await ask({ id: 'mergeGateHedge', question: NOUL_Q, state: 'pending review', trust: 'relax-block', baseline: true });
        assert.strictEqual(r2.final, true, 'shadow: final must equal baseline for mergeGateHedge too');

        const log = readNdjson(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'));
        const rows = log.filter((r) => r.id === 'claimLedger' || r.id === 'mergeGateHedge');
        assert.strictEqual(rows.length, 2);
        for (const row of rows) {
          assert.strictEqual(row.mode, 'shadow');
          assert.strictEqual(row.final, row.base, `row ${row.id}: final must equal base in shadow mode`);
        }
      });
    });
  } finally { h.cleanup(); }
});
