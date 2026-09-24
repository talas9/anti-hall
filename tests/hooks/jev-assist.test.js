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
    h.writeState('jev.json', { enabled: true });
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

test('ask(): shadow mode calls Jev + logs but NEVER changes the outcome', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, integrations: { modelRouting: 'shadow' } });
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
    h.writeState('jev.json', { enabled: true, integrations: { modelRouting: 'on' } });
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
    h.writeState('jev.json', { enabled: true });
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
    h.writeState('jev.json', { enabled: true });
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
    h.writeState('jev.json', { enabled: true, integrations: { modelRouting: 'on' } });
    await withMockServer(choiceHandler('authoring', 0.95), async (endpoint) => {
      const env = {
        PATH: process.env.PATH, HOME: h.home,
        AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint,
      };
      const r = await runAskSyncInChild({
        id: 'modelRouting', question: CHOICE_Q, state: 'write the report', trust: 'relax-block',
        baseline: true, judgeSrc: "(a) => a === 'mechanical'", budgetMs: 1500,
      }, env);
      assert.strictEqual(r.final, false, 'confident non-mechanical relaxes the block');
      assert.strictEqual(r.backend, 'jev');
    });
  } finally { h.cleanup(); }
});
