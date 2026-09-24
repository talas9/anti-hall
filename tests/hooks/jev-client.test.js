'use strict';
// jev-client.js — unit tests, in-process (direct require), never touching the
// real network. A local http server (ANTIHALL_JEV_TEST_ENDPOINT, a test-only
// escape hatch the module never documents to users) stands in for the
// Vercel AI Gateway / TypeSafe endpoint.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');

const LIB = require.resolve('../../plugins/anti-hall/hooks/lib/jev-client.js');

// Fresh require each time so module-level state (there is none, but be safe)
// never leaks between tests, and so env-driven config is always re-read.
function freshLib() {
  delete require.cache[LIB];
  return require(LIB);
}

const ENV_KEYS = [
  'HOME', 'ANTIHALL_JEV', 'AI_GATEWAY_API_KEY', 'TYPESAFE_API_KEY',
  'ANTIHALL_JEV_TEST_ENDPOINT',
];

// NOTE: awaits fn() INSIDE the try (matches jev-assist.test.js's sibling
// helper) -- getCreditBalanceCached tests make TWO sequential async calls
// per withEnv block, and restoring env before the first call's promise
// settles would silently point the second call at the REAL (non-fixture)
// HOME/endpoint instead of the mock.
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

async function withMockServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/mock`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); }
    });
  });
}

const NOUL_QUESTION = {
  type: 'noul',
  instructions: 'Is this speculating?',
  criteria: { true: 'yes', false: 'no' },
};

const CHOICE_QUESTION = {
  type: 'choice',
  instructions: 'Pick one',
  criteria: ['a', 'b'],
};

// ---------------------------------------------------------------------------
// loadJevConfig
// ---------------------------------------------------------------------------

test('loadJevConfig: no jev.json, no env -> disabled (default OFF)', () => {
  const h = makeHome();
  try {
    withEnv({ HOME: h.home }, () => {
      const { loadJevConfig } = freshLib();
      const cfg = loadJevConfig();
      assert.strictEqual(cfg.enabled, false);
      assert.strictEqual(cfg.transport, 'vercel');
      assert.strictEqual(cfg.timeoutMs, 1500);
      assert.strictEqual(cfg.confidenceThreshold, 0.85);
    });
  } finally {
    h.cleanup();
  }
});

test('loadJevConfig: jev.json {enabled:true} -> enabled, custom fields honored', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, transport: 'typesafe', timeoutMs: 999, confidenceThreshold: 0.6 });
    withEnv({ HOME: h.home }, () => {
      const { loadJevConfig } = freshLib();
      const cfg = loadJevConfig();
      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.transport, 'typesafe');
      assert.strictEqual(cfg.timeoutMs, 999);
      assert.strictEqual(cfg.confidenceThreshold, 0.6);
    });
  } finally {
    h.cleanup();
  }
});

test('loadJevConfig: ANTIHALL_JEV=1 enables without jev.json', () => {
  const h = makeHome();
  try {
    withEnv({ HOME: h.home, ANTIHALL_JEV: '1' }, () => {
      const { loadJevConfig } = freshLib();
      assert.strictEqual(loadJevConfig().enabled, true);
    });
  } finally {
    h.cleanup();
  }
});

test('loadJevConfig: ANTIHALL_JEV=0 force-disables even when jev.json says enabled:true', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true });
    withEnv({ HOME: h.home, ANTIHALL_JEV: '0' }, () => {
      const { loadJevConfig } = freshLib();
      assert.strictEqual(loadJevConfig().enabled, false);
    });
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// jevDecide — disabled / no-key
// ---------------------------------------------------------------------------

test('jevDecide: disabled -> {ok:false, reason:"disabled"}, no network attempted', async () => {
  const h = makeHome();
  try {
    await withEnv({ HOME: h.home }, async () => {
      const { jevDecide } = freshLib();
      const r = await jevDecide({ question: NOUL_QUESTION, state: 'hello' });
      assert.deepStrictEqual(r, { ok: false, reason: 'disabled' });
    });
  } finally {
    h.cleanup();
  }
});

test('jevDecide: enabled, no key anywhere -> {ok:false, reason:"no-key"}', async () => {
  const h = makeHome();
  try {
    await withEnv({ HOME: h.home, ANTIHALL_JEV: '1' }, async () => {
      const { jevDecide } = freshLib();
      const r = await jevDecide({ question: NOUL_QUESTION, state: 'hello' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, 'no-key');
    });
  } finally {
    h.cleanup();
  }
});

test('jevDecide: unknown question.type ("multi") -> {ok:false, reason:"bad-question"}, no HTTP request', async () => {
  const h = makeHome();
  try {
    await withMockServer(
      (_req, res) => {
        assert.fail('no HTTP request should be made for a bad question type');
        res.end();
      },
      async (endpoint) => {
        await withEnv(
          { HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'test-key', ANTIHALL_JEV_TEST_ENDPOINT: endpoint },
          async () => {
            const { jevDecide } = freshLib();
            const r = await jevDecide({ question: { type: 'multi', instructions: 'x', criteria: [] }, state: 'hello' });
            assert.deepStrictEqual(r, { ok: false, reason: 'bad-question' });
          }
        );
      }
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// jevDecide — happy paths (mock server, noul + choice)
// ---------------------------------------------------------------------------

test('jevDecide: noul happy path, high confidence (noul=0.95 -> answer true)', async () => {
  const h = makeHome();
  try {
    await withMockServer(async (req, res) => {
      const body = await readJsonBody(req);
      assert.ok(body && body.questions && body.questions.decision, 'sends the question under questions.decision');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: 0.95 } } }));
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'jev-test-key-should-never-leak', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { jevDecide } = freshLib();
        const r = await jevDecide({ question: NOUL_QUESTION, state: 'The cause is X.' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.answer, true);
        assert.ok(Math.abs(r.confidence - 0.9) < 1e-9);
        assert.ok(Number.isFinite(r.ms));
      });
    });
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// extractCostAndUsage — pure function, defensive parsing per the doc-cited
// field names (see the function's own comment for the two Vercel URLs).
// ---------------------------------------------------------------------------

test('extractCostAndUsage: none of the documented fields present -> all null (the observed systemone shape)', () => {
  const { extractCostAndUsage } = freshLib();
  const r = extractCostAndUsage({ answers: { decision: { noul: 0.9 } } });
  assert.deepStrictEqual(r, { cost: null, tokensIn: null, tokensOut: null, model: null });
});

test('extractCostAndUsage: generation-lookup-shaped cost/token fields are picked up', () => {
  const { extractCostAndUsage } = freshLib();
  const r = extractCostAndUsage({
    total_cost: 0.0012, tokens_prompt: 100, tokens_completion: 50, model: 'typesafe-ai/jev',
  });
  assert.strictEqual(r.cost, 0.0012);
  assert.strictEqual(r.tokensIn, 100);
  assert.strictEqual(r.tokensOut, 50);
  assert.strictEqual(r.model, 'typesafe-ai/jev');
});

test('extractCostAndUsage: TypeSafe\'s OWN documented usage field names (input_tokens/output_tokens) are extracted', () => {
  const { extractCostAndUsage } = freshLib();
  const r = extractCostAndUsage({ model: 'jev-latest', usage: { input_tokens: 55, output_tokens: 12 } });
  assert.strictEqual(r.tokensIn, 55);
  assert.strictEqual(r.tokensOut, 12);
  assert.strictEqual(r.model, 'jev-latest');
  assert.strictEqual(r.cost, null, 'TypeSafe docs do not document a cost field on this response');
});

test('extractCostAndUsage: OpenAI-chat-completions-shaped usage object is a defensive fallback for tokens', () => {
  const { extractCostAndUsage } = freshLib();
  const r = extractCostAndUsage({ usage: { prompt_tokens: 10, completion_tokens: 4 } });
  assert.strictEqual(r.tokensIn, 10);
  assert.strictEqual(r.tokensOut, 4);
  assert.strictEqual(r.cost, null, 'no cost field present -> null, never derived from tokens here');
});

test('extractCostAndUsage: null/non-object input -> all null, never throws', () => {
  const { extractCostAndUsage } = freshLib();
  assert.deepStrictEqual(extractCostAndUsage(null), { cost: null, tokensIn: null, tokensOut: null, model: null });
  assert.deepStrictEqual(extractCostAndUsage(undefined), { cost: null, tokensIn: null, tokensOut: null, model: null });
});

test('jevDecide: when the response happens to carry cost/usage fields, they pass through on the result', async () => {
  const h = makeHome();
  try {
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        answers: { decision: { noul: 0.95 } },
        total_cost: 0.0007, tokens_prompt: 42, tokens_completion: 7, model: 'typesafe-ai/jev',
      }));
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { jevDecide } = freshLib();
        const r = await jevDecide({ question: NOUL_QUESTION, state: 'hello' });
        assert.strictEqual(r.cost, 0.0007);
        assert.strictEqual(r.tokensIn, 42);
        assert.strictEqual(r.tokensOut, 7);
        assert.strictEqual(r.model, 'typesafe-ai/jev');
      });
    });
  } finally {
    h.cleanup();
  }
});

test('jevDecide: real (observed) response shape with no cost/usage fields -> cost/tokens/model all null', async () => {
  const h = makeHome();
  try {
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: 0.95 } } }));
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { jevDecide } = freshLib();
        const r = await jevDecide({ question: NOUL_QUESTION, state: 'hello' });
        assert.strictEqual(r.cost, null);
        assert.strictEqual(r.tokensIn, null);
        assert.strictEqual(r.tokensOut, null);
      });
    });
  } finally {
    h.cleanup();
  }
});

test('jevDecide: noul low confidence (noul=0.55 -> confidence 0.1)', async () => {
  const h = makeHome();
  try {
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: 0.55 } } }));
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { jevDecide } = freshLib();
        const r = await jevDecide({ question: NOUL_QUESTION, state: 'hello' });
        assert.strictEqual(r.ok, true);
        assert.ok(Math.abs(r.confidence - 0.1) < 1e-9);
      });
    });
  } finally {
    h.cleanup();
  }
});

test('jevDecide: choice happy path', async () => {
  const h = makeHome();
  try {
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { choice: 'a', confidence: 0.77 } } }));
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { jevDecide } = freshLib();
        const r = await jevDecide({ question: CHOICE_QUESTION, state: 'hello' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.answer, 'a');
        assert.strictEqual(r.confidence, 0.77);
      });
    });
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// jevDecide — failure modes, all fail-open with a reason
// ---------------------------------------------------------------------------

test('jevDecide: HTTP 500 -> {ok:false, reason:"http-500"}', async () => {
  const h = makeHome();
  try {
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { jevDecide } = freshLib();
        const r = await jevDecide({ question: NOUL_QUESTION, state: 'hello' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'http-500');
      });
    });
  } finally {
    h.cleanup();
  }
});

test('jevDecide: malformed JSON body -> {ok:false, reason:"parse-error"}', async () => {
  const h = makeHome();
  try {
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{not valid json');
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { jevDecide } = freshLib();
        const r = await jevDecide({ question: NOUL_QUESTION, state: 'hello' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'parse-error');
      });
    });
  } finally {
    h.cleanup();
  }
});

test('jevDecide: missing answers.decision shape -> {ok:false, reason:"bad-response"}', async () => {
  const h = makeHome();
  try {
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: {} }));
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { jevDecide } = freshLib();
        const r = await jevDecide({ question: NOUL_QUESTION, state: 'hello' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'bad-response');
      });
    });
  } finally {
    h.cleanup();
  }
});

test('jevDecide: timeout -> {ok:false, reason:"timeout"} (server never responds)', async () => {
  const h = makeHome();
  try {
    await withMockServer((req, res) => {
      // never respond — the client's timeoutMs must fire first.
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { jevDecide } = freshLib();
        const r = await jevDecide({ question: NOUL_QUESTION, state: 'hello', timeoutMs: 150 });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'timeout');
      });
    });
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P1-b regression: the timer used to be cleared right after fetch() resolved
// (i.e. after headers), BEFORE res.text() read the body — so a server that
// sends headers then stalls the body could hang past the configured timeout,
// all the way to the hook's own outer Stop timeout. The fix keeps ONE
// deadline covering request+headers+body (the same AbortController/timer is
// only cleared after res.text() settles), and clamps any configured/override
// timeoutMs to MAX_TIMEOUT_MS (3000ms) so a misconfigured large timeout can't
// reopen the same risk.
// ---------------------------------------------------------------------------
test('jevDecide: headers sent, body stalls -> returns within the timeout bound, reason:"timeout" (fail-open)', async () => {
  const h = makeHome();
  try {
    await withMockServer((req, res) => {
      // Send headers (and flush them) but never write/end the body — the
      // pre-fix client would clear its timer right here and hang forever.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      // Deliberately never call res.write()/res.end().
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { jevDecide } = freshLib();
        const timeoutMs = 200;
        const start = Date.now();
        const r = await jevDecide({ question: NOUL_QUESTION, state: 'hello', timeoutMs });
        const elapsed = Date.now() - start;
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'timeout');
        assert.ok(
          elapsed < timeoutMs + 2000,
          `must return within the timeout bound, not hang on the stalled body (elapsed=${elapsed}ms)`
        );
      });
    });
  } finally {
    h.cleanup();
  }
});

test('loadJevConfig: timeoutMs > MAX_TIMEOUT_MS is clamped to 3000; default stays 1500', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 30000 });
    withEnv({ HOME: h.home }, () => {
      const { loadJevConfig, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } = freshLib();
      assert.strictEqual(MAX_TIMEOUT_MS, 3000);
      assert.strictEqual(DEFAULT_TIMEOUT_MS, 1500);
      assert.strictEqual(loadJevConfig().timeoutMs, 3000);
    });
  } finally {
    h.cleanup();
  }
});

test('loadJevConfig: no explicit timeoutMs -> default 1500 (unclamped default untouched)', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true });
    withEnv({ HOME: h.home }, () => {
      const { loadJevConfig } = freshLib();
      assert.strictEqual(loadJevConfig().timeoutMs, 1500);
    });
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Credential resolution: keyFile, and never leaking the key
// ---------------------------------------------------------------------------

test('jevDecide: credential from jev.json keyFile when env var absent', async () => {
  const h = makeHome();
  try {
    const keyPath = path.join(h.home, 'my-jev-key');
    fs.writeFileSync(keyPath, 'secret-from-keyfile\n', 'utf8');
    h.writeState('jev.json', { enabled: true, keyFile: keyPath });
    let seenAuth = null;
    await withMockServer(async (req, res) => {
      seenAuth = req.headers['authorization'];
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: 0.9 } } }));
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { jevDecide } = freshLib();
        const r = await jevDecide({ question: NOUL_QUESTION, state: 'hello' });
        assert.strictEqual(r.ok, true);
      });
    });
    assert.strictEqual(seenAuth, 'Bearer secret-from-keyfile');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// getCreditBalance / getCreditBalanceCached
//
// Vercel AI Gateway docs (verified):
//   https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#check-credit-balance
//   GET /v1/credits -> {"balance": "95.50", "total_used": "4.50"}
// TypeSafe's own docs (https://docs.typesafe.ai/api) document NO equivalent
// endpoint -- "typesafe" transport must report unsupported-transport, never
// invent one.
// ---------------------------------------------------------------------------

function creditsHandler(balance, totalUsed) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ balance, total_used: totalUsed }));
  };
}

test('getCreditBalance: "typesafe" transport -> unsupported-transport, no HTTP call made', async () => {
  const h = makeHome();
  try {
    await withMockServer(
      (_req, res) => { assert.fail('no HTTP request should be made for the typesafe transport'); res.end(); },
      async (endpoint) => {
        await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', TYPESAFE_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
          h.writeState('jev.json', { enabled: true, transport: 'typesafe' });
          const { getCreditBalance } = freshLib();
          const r = await getCreditBalance({});
          assert.deepStrictEqual(r, { ok: false, reason: 'unsupported-transport' });
        });
      }
    );
  } finally { h.cleanup(); }
});

test('getCreditBalance: Jev disabled -> {ok:false, reason:"disabled"}', async () => {
  const h = makeHome();
  try {
    await withEnv({ HOME: h.home }, async () => {
      const { getCreditBalance } = freshLib();
      const r = await getCreditBalance({});
      assert.deepStrictEqual(r, { ok: false, reason: 'disabled' });
    });
  } finally { h.cleanup(); }
});

test('getCreditBalance: enabled, vercel transport, no key -> {ok:false, reason:"no-key"}', async () => {
  const h = makeHome();
  try {
    await withEnv({ HOME: h.home, ANTIHALL_JEV: '1' }, async () => {
      const { getCreditBalance } = freshLib();
      const r = await getCreditBalance({});
      assert.deepStrictEqual(r, { ok: false, reason: 'no-key' });
    });
  } finally { h.cleanup(); }
});

test('getCreditBalance: happy path parses balance/total_used as numbers', async () => {
  const h = makeHome();
  try {
    await withMockServer(creditsHandler('95.50', '4.50'), async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { getCreditBalance } = freshLib();
        const r = await getCreditBalance({});
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.balanceUsd, 95.50);
        assert.strictEqual(r.totalUsedUsd, 4.50);
        assert.ok(Number.isFinite(r.ms));
      });
    });
  } finally { h.cleanup(); }
});

test('getCreditBalance: HTTP failure -> http-<status>', async () => {
  const h = makeHome();
  try {
    await withMockServer((_req, res) => { res.writeHead(500); res.end('nope'); }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { getCreditBalance } = freshLib();
        const r = await getCreditBalance({});
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'http-500');
      });
    });
  } finally { h.cleanup(); }
});

test('getCreditBalance: missing balance field -> bad-response, never fabricated', async () => {
  const h = makeHome();
  try {
    await withMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total_used: '1.00' }));
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { getCreditBalance } = freshLib();
        const r = await getCreditBalance({});
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'bad-response');
      });
    });
  } finally { h.cleanup(); }
});

test('getCreditBalanceCached: caches the result for the TTL window -- one network call across two invocations', async () => {
  const h = makeHome();
  try {
    let calls = 0;
    await withMockServer((_req, res) => { calls++; creditsHandler('10.00', '1.00')(_req, res); }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { getCreditBalanceCached } = freshLib();
        const r1 = await getCreditBalanceCached({});
        const r2 = await getCreditBalanceCached({});
        assert.strictEqual(r1.cached, false);
        assert.strictEqual(r2.cached, true);
        assert.strictEqual(r2.balanceUsd, 10.00);
        assert.strictEqual(calls, 1, 'the second call must be served from cache, not the network');
      });
    });
  } finally { h.cleanup(); }
});

test('getCreditBalanceCached: forceRefresh bypasses the cache', async () => {
  const h = makeHome();
  try {
    let calls = 0;
    await withMockServer((_req, res) => { calls++; creditsHandler('10.00', '1.00')(_req, res); }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { getCreditBalanceCached } = freshLib();
        await getCreditBalanceCached({});
        await getCreditBalanceCached({ forceRefresh: true });
        assert.strictEqual(calls, 2);
      });
    });
  } finally { h.cleanup(); }
});

test('jevDecide: the API key never appears in a returned reason string, on any failure path', async () => {
  const h = makeHome();
  try {
    const secret = 'JEV-SECRET-DO-NOT-LEAK-abc123';
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('server error, key was: ' + secret); // server "echoes" it; client must not propagate it
    }, async (endpoint) => {
      await withEnv({ HOME: h.home, ANTIHALL_JEV: '1', AI_GATEWAY_API_KEY: secret, ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { jevDecide } = freshLib();
        const r = await jevDecide({ question: NOUL_QUESTION, state: 'hello' });
        const serialized = JSON.stringify(r);
        assert.ok(!serialized.includes(secret), `result must never contain the API key: ${serialized}`);
      });
    });
  } finally {
    h.cleanup();
  }
});
