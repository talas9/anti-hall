'use strict';
// speculation-judge (Stop hook, OPT-IN). Without ANTIHALL_SEMANTIC_JUDGE=1 it
// exits 0 immediately regardless of transcript. We never test the live API path.
//
// JEV integration tests (bottom of file): a local mock HTTP server stands in
// for the Vercel AI Gateway (ANTIHALL_JEV_TEST_ENDPOINT, jev-client.js's
// test-only escape hatch). Real ANTHROPIC calls in these tests always use a
// fake key and fail open, exactly like the pre-existing Haiku tests above —
// we only assert on exit code / block / the jev-judge.ndjson log, never on a
// real network round-trip.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { testHook, testHookRaw, HOOKS_DIR } = require('../helpers/spawn-hook.js');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');

const HOOK = 'speculation-judge.js';

function stopPayload(transcriptPath) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: 't' };
}

// testHookAsync — like spawn-hook.js's testHook, but non-blocking (spawn, not
// spawnSync). REQUIRED for the Jev integration tests below: they run an
// in-process mock HTTP server in this SAME test process, and spawnSync would
// synchronously block this process's event loop for its whole duration —
// starving that mock server of the ability to ever accept/respond to the
// spawned hook's request (a same-process deadlock, not a sandbox limit).
function testHookAsync(hookRelPath, payloadObj, opts = {}) {
  const hookAbs = path.isAbsolute(hookRelPath) ? hookRelPath : path.join(HOOKS_DIR, hookRelPath);
  const env = { PATH: process.env.PATH, HOME: opts.home, ...(opts.env || {}) };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookAbs], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch (_) { json = null; }
      resolve({ status, stdout, stderr, json });
    });
    child.stdin.end(JSON.stringify(payloadObj));
  });
}

function withMockServer(handler, fn) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        const result = await fn(`http://127.0.0.1:${port}/mock`);
        server.close(() => resolve(result));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); } });
  });
}

function readNdjson(home) {
  const p = path.join(home, '.anti-hall', 'logs', 'jev-judge.ndjson');
  try {
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

test('OPT-OUT default: no ANTIHALL_SEMANTIC_JUDGE -> exit 0, no block', () => {
  const h = makeHome();
  try {
    // A confidently-stated unverified inference (would be a candidate to block if
    // the judge ran) — but the judge is disabled by default.
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

// SKIP-HATCH: speculation-judge calls isSkipped('speculation-judge') at
// speculation-judge.js:290, AFTER the ANTIHALL_SEMANTIC_JUDGE=1 env gate (line 64)
// but BEFORE the API-key check (line 306) and any network call. So to exercise the
// skip path we must ENABLE the judge (else it exits 0 at the env gate, never
// reaching the skip check). With the judge enabled AND an API key present, an
// unverified-inference transcript WOULD proceed toward the API; an explicit skip
// must short-circuit to exit 0 at line 290 before any of that. We assert exit 0 +
// no block. We never make a real API call: the skip fires before the network path.
test('SKIP-HATCH: skip.json {speculation-judge: future} -> exit 0, no block (judge enabled + key present)', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'speculation-judge': Date.now() + 600000 });
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTIHALL_SEMANTIC_JUDGE: '1', ANTHROPIC_API_KEY: 'sk-test-not-used' },
    });
    assert.strictEqual(r.status, 0, `expected allow under skip; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `skip must suppress any block; json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('SKIP-HATCH: broad "all" skip also covers speculation-judge (non-destructive)', () => {
  const h = makeHome();
  try {
    // speculation-judge is NOT in skip-guard's DESTRUCTIVE set, so a broad "all"
    // skip applies (skip-guard.js:50-53). Enabled judge + key, "all" skip -> exit 0.
    h.writeSkip({ all: Date.now() + 600000 });
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTIHALL_SEMANTIC_JUDGE: '1', ANTHROPIC_API_KEY: 'sk-test-not-used' },
    });
    assert.strictEqual(r.status, 0, `expected allow under "all" skip; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `"all" skip must suppress any block; json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('ANTIHALL_JUDGE_MODEL default: no override -> hook reaches API path, fails open (fake key)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTIHALL_SEMANTIC_JUDGE: '1', ANTHROPIC_API_KEY: 'sk-ant-fake-default' },
    });
    // Network will fail (fake key) -> fail-open -> exit 0, no block
    assert.strictEqual(r.status, 0, `expected fail-open exit 0; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `fail-open must not block; json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('ANTIHALL_JUDGE_MODEL override: custom model env var -> hook accepts override, fails open (fake key)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: {
        ANTIHALL_SEMANTIC_JUDGE: '1',
        ANTHROPIC_API_KEY: 'sk-ant-fake-override',
        ANTIHALL_JUDGE_MODEL: 'claude-test-model-override',
      },
    });
    // Network will fail (fake key) -> fail-open -> exit 0, no block
    assert.strictEqual(r.status, 0, `expected fail-open exit 0 with model override; stdout: ${r.stdout}`);
    assert.ok(!(r.json && r.json.decision === 'block'), `fail-open must not block; json: ${JSON.stringify(r.json)}`);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> exit 0', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> exit 0', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// JEV integration
// ---------------------------------------------------------------------------

test('JEV disabled (default, no jev.json/env) -> byte-identical to pre-Jev behavior, no log written', async () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTIHALL_SEMANTIC_JUDGE: '1', ANTHROPIC_API_KEY: 'sk-ant-fake-nojev' },
    });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
    assert.deepStrictEqual(readNdjson(h.home), [], 'no jev-judge.ndjson line when Jev is disabled');
  } finally {
    h.cleanup();
  }
});

test('JEV enabled, high-confidence "block" verdict -> uses Jev, never calls Haiku, blocks, logs backend:jev', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, confidenceThreshold: 0.85 });
    let calls = 0;
    await withMockServer(async (req, res) => {
      calls++;
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: 0.97 } } }));
    }, async (endpoint) => {
      const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
      const r = await testHookAsync(HOOK, stopPayload(tp), {
        home: h.home,
        env: {
          ANTIHALL_SEMANTIC_JUDGE: '1',
          AI_GATEWAY_API_KEY: 'jev-key-should-not-leak',
          ANTIHALL_JEV_TEST_ENDPOINT: endpoint,
          // deliberately NO ANTHROPIC_API_KEY — Jev alone must be sufficient.
        },
      });
      assert.strictEqual(r.status, 0);
      assert.ok(r.json && r.json.decision === 'block', `expected a block; json: ${JSON.stringify(r.json)}`);
    });
    assert.strictEqual(calls, 1, 'Jev endpoint hit exactly once');
    const log = readNdjson(h.home);
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].backend, 'jev');
    assert.strictEqual(log[0].verdict, 'block');
    assert.ok(log[0].confidence >= 0.85);
  } finally {
    h.cleanup();
  }
});

test('JEV enabled, high-confidence "allow" verdict -> exit 0, no block, logs backend:jev verdict:allow', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true });
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: 0.02 } } }));
    }, async (endpoint) => {
      const tp = h.writeTranscript([assistantMessage('I have not verified this, but it might be the cache.')]);
      const r = await testHookAsync(HOOK, stopPayload(tp), {
        home: h.home,
        env: { ANTIHALL_SEMANTIC_JUDGE: '1', AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint },
      });
      assert.strictEqual(r.status, 0);
      assert.ok(!(r.json && r.json.decision === 'block'));
    });
    const log = readNdjson(h.home);
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].backend, 'jev');
    assert.strictEqual(log[0].verdict, 'allow');
  } finally {
    h.cleanup();
  }
});

test('JEV enabled, LOW confidence -> falls back to Haiku path (fake key fails open), logs backend:jev→haiku reason:low-confidence', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, confidenceThreshold: 0.85 });
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: 0.6 } } })); // confidence 0.2 < 0.85
    }, async (endpoint) => {
      const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
      const r = await testHookAsync(HOOK, stopPayload(tp), {
        home: h.home,
        env: {
          ANTIHALL_SEMANTIC_JUDGE: '1',
          AI_GATEWAY_API_KEY: 'k',
          ANTIHALL_JEV_TEST_ENDPOINT: endpoint,
          ANTHROPIC_API_KEY: 'sk-ant-fake-fallback', // Haiku path reached, then fails open (fake key)
        },
      });
      assert.strictEqual(r.status, 0, `expected fail-open exit 0; stdout: ${r.stdout}`);
      assert.ok(!(r.json && r.json.decision === 'block'));
    });
    const log = readNdjson(h.home);
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].backend, 'jev→haiku');
    assert.strictEqual(log[0].reason, 'low-confidence');
  } finally {
    h.cleanup();
  }
});

test('JEV enabled, TIMEOUT -> falls back to Haiku, logs backend:jev→haiku reason:timeout', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 150 });
    await withMockServer((req, res) => {
      // never respond
    }, async (endpoint) => {
      const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
      const r = await testHookAsync(HOOK, stopPayload(tp), {
        home: h.home,
        env: {
          ANTIHALL_SEMANTIC_JUDGE: '1',
          AI_GATEWAY_API_KEY: 'k',
          ANTIHALL_JEV_TEST_ENDPOINT: endpoint,
          ANTHROPIC_API_KEY: 'sk-ant-fake-timeout',
        },
      });
      assert.strictEqual(r.status, 0);
      assert.ok(!(r.json && r.json.decision === 'block'));
    });
    const log = readNdjson(h.home);
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].backend, 'jev→haiku');
    assert.strictEqual(log[0].reason, 'timeout');
  } finally {
    h.cleanup();
  }
});

test('JEV enabled, HTTP 500 -> falls back to Haiku, logs reason:http-500', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true });
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
    }, async (endpoint) => {
      const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
      const r = await testHookAsync(HOOK, stopPayload(tp), {
        home: h.home,
        env: {
          ANTIHALL_SEMANTIC_JUDGE: '1',
          AI_GATEWAY_API_KEY: 'k',
          ANTIHALL_JEV_TEST_ENDPOINT: endpoint,
          ANTHROPIC_API_KEY: 'sk-ant-fake-500',
        },
      });
      assert.strictEqual(r.status, 0);
    });
    const log = readNdjson(h.home);
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].backend, 'jev→haiku');
    assert.strictEqual(log[0].reason, 'http-500');
  } finally {
    h.cleanup();
  }
});

test('JEV enabled, missing key (no env, no keyFile) -> falls back to Haiku, logs reason:no-key', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true });
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTIHALL_SEMANTIC_JUDGE: '1', ANTHROPIC_API_KEY: 'sk-ant-fake-nokey' },
    });
    assert.strictEqual(r.status, 0);
    const log = readNdjson(h.home);
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].backend, 'jev→haiku');
    assert.strictEqual(log[0].reason, 'no-key');
  } finally {
    h.cleanup();
  }
});

test('JEV enabled, malformed JSON response -> falls back to Haiku, logs reason:parse-error', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true });
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{not json');
    }, async (endpoint) => {
      const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
      const r = await testHookAsync(HOOK, stopPayload(tp), {
        home: h.home,
        env: {
          ANTIHALL_SEMANTIC_JUDGE: '1',
          AI_GATEWAY_API_KEY: 'k',
          ANTIHALL_JEV_TEST_ENDPOINT: endpoint,
          ANTHROPIC_API_KEY: 'sk-ant-fake-parseerr',
        },
      });
      assert.strictEqual(r.status, 0);
    });
    const log = readNdjson(h.home);
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].backend, 'jev→haiku');
    assert.strictEqual(log[0].reason, 'parse-error');
  } finally {
    h.cleanup();
  }
});

test('ANTIHALL_JEV=0 overrides jev.json {enabled:true} -> byte-identical disabled behavior, no log', () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true });
    const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
    const r = testHook(HOOK, stopPayload(tp), {
      home: h.home,
      env: { ANTIHALL_SEMANTIC_JUDGE: '1', ANTIHALL_JEV: '0', ANTHROPIC_API_KEY: 'sk-ant-fake-override0' },
    });
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(readNdjson(h.home), []);
  } finally {
    h.cleanup();
  }
});

test('JEV: the API key never appears in the jev-judge.ndjson log or stdout/stderr, on any failure path', async () => {
  const h = makeHome();
  try {
    const secret = 'JEV-KEY-MUST-NOT-LEAK-xyz789';
    h.writeState('jev.json', { enabled: true });
    await withMockServer(async (req, res) => {
      await readJsonBody(req);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('upstream error, saw key ' + secret);
    }, async (endpoint) => {
      const tp = h.writeTranscript([assistantMessage('The cause is the old build artifact.')]);
      const r = await testHookAsync(HOOK, stopPayload(tp), {
        home: h.home,
        env: {
          ANTIHALL_SEMANTIC_JUDGE: '1',
          AI_GATEWAY_API_KEY: secret,
          ANTIHALL_JEV_TEST_ENDPOINT: endpoint,
          ANTHROPIC_API_KEY: 'sk-ant-fake-secretcheck',
        },
      });
      assert.ok(!r.stdout.includes(secret), 'stdout must never contain the key');
      assert.ok(!r.stderr.includes(secret), 'stderr must never contain the key');
    });
    const logRaw = fs.readFileSync(path.join(h.home, '.anti-hall', 'logs', 'jev-judge.ndjson'), 'utf8');
    assert.ok(!logRaw.includes(secret), `log must never contain the key: ${logRaw}`);
  } finally {
    h.cleanup();
  }
});
