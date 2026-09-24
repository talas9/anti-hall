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

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, overrides);
    return fn();
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
