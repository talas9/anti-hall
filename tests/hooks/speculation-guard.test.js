'use strict';
// speculation-guard (Stop hook). Block => stdout {decision:'block'} + exit 0.
//
// State file derivation (from speculation-guard.js): session_id 't' -> safeSession
// 't' -> ~/.anti-hall/speculation-guard-state-t.json. Transcript is JSONL; the hook
// reads the LAST assistant message text. A hedge word (e.g. "should be") with no
// acknowledgment blocks; an acknowledgment ("verified", "haven't checked", etc.)
// suppresses it.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');

const HOOK = 'speculation-guard.js';
const STATE_FILE = 'speculation-guard-state-t.json';

function stopPayload(transcriptPath) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: 't' };
}

function isBlock(r) {
  return r.status === 0 && r.json && r.json.decision === 'block';
}

test('BLOCK: hedge without acknowledgment', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      assistantMessage('I made the change.'),
      assistantMessage('This should be fine now.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(isBlock(r), `expected block; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW: hedge WITH acknowledgment', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      assistantMessage('It should be fine, but I have not verified it yet — let me verify.'),
    ]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow (acknowledged); stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ALLOW: no hedge marker at all', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage('I ran the test and it passed: 5/5.')]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `expected allow (no hedge); stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('MAX_BLOCKS cap: blocks=3 already -> even a hedge ALLOWS', () => {
  const h = makeHome();
  try {
    // Pre-seed the state with a DIFFERENT hash so the dedupe path is not what
    // suppresses the block — only the cap should. blocks:3 == MAX_BLOCKS.
    h.writeState(STATE_FILE, { hash: 'differenthash', blocks: 3 });
    const tp = h.writeTranscript([assistantMessage('This should be fine.')]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `cap reached; expected allow; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('ESCAPE HATCH: skip.json {speculation-guard: future} -> allow despite hedge', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'speculation-guard': Date.now() + 600000 });
    const tp = h.writeTranscript([assistantMessage('This should be fine.')]);
    const r = testHook(HOOK, stopPayload(tp), { home: h.home });
    assert.ok(!isBlock(r), `skip active; expected allow; stdout: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> no block', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.ok(!(r.json && r.json.decision === 'block'));
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// JEV integration (opt-in). A local mock HTTP server stands in for the Vercel
// AI Gateway via ANTIHALL_JEV_TEST_ENDPOINT (jev-client.js's test-only hatch);
// no test here touches the real network. Children are spawned async (not
// spawnSync) so this process's event loop can serve the mock.
// ---------------------------------------------------------------------------
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HOOKS_DIR } = require('../helpers/spawn-hook.js');

function runAsync(payloadObj, opts) {
  const env = { PATH: process.env.PATH, HOME: opts.home, ...(opts.env || {}) };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HOOKS_DIR, HOOK)], { env });
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

// mockJev(respond) -> { endpoint, calls, bodies, close }. respond(req,res,body).
function mockJev(respond) {
  const state = { calls: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      state.calls++;
      let body = null;
      try { body = JSON.parse(raw); } catch (_) {}
      state.bodies.push(body);
      respond(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.endpoint = `http://127.0.0.1:${server.address().port}/mock`;
      state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
      resolve(state);
    });
  });
}

function noul(n) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answers: { decision: { noul: n } } }));
  };
}

function readLog(home) {
  try {
    return fs.readFileSync(path.join(home, '.anti-hall', 'logs', 'jev-judge.ndjson'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

const NO_HEDGE_SPEC = 'Fixed. The race condition was in the retry loop, so the flaky test is resolved.';
const HEDGE_SPEC = 'This should be fine now.';
const GROUNDED = 'Ran `node --test`: 12 pass, 0 fail (output above).';

async function jevCase({ reply, respond, jevCfg = { enabled: true }, env = {}, setup }) {
  const h = makeHome();
  const mock = await mockJev(respond || noul(0.5));
  try {
    if (jevCfg) h.writeState('jev.json', jevCfg);
    if (setup) setup(h);
    const tp = h.writeTranscript([assistantMessage(reply)]);
    const run = () => runAsync(stopPayload(tp), {
      home: h.home,
      env: { AI_GATEWAY_API_KEY: 'jev-test-key-never-logged', ANTIHALL_JEV_TEST_ENDPOINT: mock.endpoint, ...env },
    });
    const r = await run();
    return { r, run, mock, log: () => readLog(h.home), h };
  } finally {
    await mock.close();
    // cleanup deferred to caller via h.cleanup (loop-safety test re-runs)
  }
}

test('JEV off (no jev.json): regex behavior unchanged, Jev never called, nothing logged', async () => {
  const c = await jevCase({ reply: HEDGE_SPEC, jevCfg: null, respond: noul(0.02) });
  try {
    assert.ok(isBlock(c.r), 'regex still blocks the hedge');
    assert.strictEqual(c.mock.calls, 0);
    assert.deepStrictEqual(c.log(), []);
  } finally { c.h.cleanup(); }
});

test('JEV: ANTIHALL_JEV=0 overrides jev.json enabled -> no call, no log, regex decides', async () => {
  const c = await jevCase({ reply: NO_HEDGE_SPEC, env: { ANTIHALL_JEV: '0' }, respond: noul(0.99) });
  try {
    assert.ok(!isBlock(c.r), 'no hedge word -> regex allows');
    assert.strictEqual(c.mock.calls, 0);
    assert.deepStrictEqual(c.log(), []);
  } finally { c.h.cleanup(); }
});

test('JEV polarity regression: question asks "speculative?" and counts hedged guesses as speculative', async () => {
  const c = await jevCase({ reply: GROUNDED, respond: noul(0.1) });
  try {
    const q = c.mock.bodies[0].questions.decision;
    assert.strictEqual(q.type, 'noul');
    assert.match(q.instructions, /speculative/i);
    assert.match(q.criteria.true, /Hedged guesses/);
    assert.match(q.criteria.true, /probably/);
    assert.doesNotMatch(q.criteria.true, /no hedge word/i, 'old rubric excluded hedged claims from "true"');
    assert.match(q.criteria.false, /12 pass, 0 fail/);
    assert.strictEqual(c.mock.bodies[0].state, GROUNDED, 'state is the last assistant message text');
  } finally { c.h.cleanup(); }
});

test('JEV confident speculative -> BLOCK even with no hedge word; logs backend:jev', async () => {
  const c = await jevCase({ reply: NO_HEDGE_SPEC, respond: noul(0.97) });
  try {
    assert.ok(isBlock(c.r), `expected block; stdout: ${c.r.stdout}`);
    assert.match(c.r.json.reason, /without citing evidence/);
    const log = c.log();
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].backend, 'jev');
    assert.strictEqual(log[0].reason, 'confident');
    assert.strictEqual(log[0].verdict, 'block');
  } finally { c.h.cleanup(); }
});

test('JEV confident grounded is NOT trusted alone: hedge still blocked by regex (asymmetric trust)', async () => {
  const c = await jevCase({ reply: HEDGE_SPEC, respond: noul(0.02) });
  try {
    assert.ok(isBlock(c.r));
    assert.match(c.r.json.reason, /should be/);
    const log = c.log();
    assert.strictEqual(log[0].backend, 'jev→regex');
    assert.strictEqual(log[0].reason, 'confident-allow-untrusted');
    assert.strictEqual(log[0].verdict, 'block');
  } finally { c.h.cleanup(); }
});

test('JEV confident grounded + no hedge -> ALLOW, logged', async () => {
  const c = await jevCase({ reply: GROUNDED, respond: noul(0.02) });
  try {
    assert.ok(!isBlock(c.r));
    const log = c.log();
    assert.deepStrictEqual([log[0].backend, log[0].reason, log[0].verdict], ['jev→regex', 'confident-allow-untrusted', 'allow']);
  } finally { c.h.cleanup(); }
});

test('JEV low confidence -> regex result, logs reason:low-confidence', async () => {
  const c = await jevCase({ reply: NO_HEDGE_SPEC, respond: noul(0.6) });
  try {
    assert.ok(!isBlock(c.r), 'regex allows a hedge-free reply');
    const log = c.log();
    assert.deepStrictEqual([log[0].backend, log[0].reason, log[0].verdict], ['jev→regex', 'low-confidence', 'allow']);
    assert.ok(Math.abs(log[0].confidence - 0.2) < 1e-9);
  } finally { c.h.cleanup(); }
});

test('JEV timeout -> regex result, logs reason:timeout', async () => {
  const c = await jevCase({ reply: HEDGE_SPEC, jevCfg: { enabled: true, timeoutMs: 150 }, respond: () => {} });
  try {
    assert.ok(isBlock(c.r));
    const log = c.log();
    assert.deepStrictEqual([log[0].backend, log[0].reason, log[0].verdict], ['jev→regex', 'timeout', 'block']);
  } finally { c.h.cleanup(); }
});

test('JEV HTTP 500 -> regex result, logs reason:http-500', async () => {
  const c = await jevCase({
    reply: NO_HEDGE_SPEC,
    respond: (req, res) => { res.writeHead(500); res.end('boom'); },
  });
  try {
    assert.ok(!isBlock(c.r));
    const log = c.log();
    assert.deepStrictEqual([log[0].backend, log[0].reason, log[0].verdict], ['jev→regex', 'http-500', 'allow']);
  } finally { c.h.cleanup(); }
});

test('JEV no credential -> regex result, logs reason:no-key', async () => {
  const c = await jevCase({ reply: HEDGE_SPEC, env: { AI_GATEWAY_API_KEY: '' }, respond: noul(0.99) });
  try {
    assert.ok(isBlock(c.r));
    assert.strictEqual(c.mock.calls, 0);
    const log = c.log();
    assert.deepStrictEqual([log[0].backend, log[0].reason, log[0].verdict], ['jev→regex', 'no-key', 'block']);
  } finally { c.h.cleanup(); }
});

test('JEV loop-safety: same message blocked once; re-run allows without a second Jev call', async () => {
  const h = makeHome();
  const mock = await mockJev(noul(0.97));
  try {
    h.writeState('jev.json', { enabled: true });
    const tp = h.writeTranscript([assistantMessage(NO_HEDGE_SPEC)]);
    const opts = { home: h.home, env: { AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: mock.endpoint } };
    const r1 = await runAsync(stopPayload(tp), opts);
    const r2 = await runAsync(stopPayload(tp), opts);
    assert.ok(isBlock(r1));
    assert.ok(!isBlock(r2), 'second Stop on the same message must allow');
    assert.strictEqual(mock.calls, 1);
    const log = readLog(h.home);
    assert.deepStrictEqual(log.map((l) => [l.backend, l.reason, l.verdict]),
      [['jev', 'confident', 'block'], ['none', 'loop-safe', 'allow']]);
  } finally {
    await mock.close();
    h.cleanup();
  }
});

test('JEV loop-safety: session block cap (3) reached -> allow, no Jev call', async () => {
  const c = await jevCase({
    reply: NO_HEDGE_SPEC,
    respond: noul(0.97),
    setup: (h) => h.writeState(STATE_FILE, { hash: 'other', blocks: 3 }),
  });
  try {
    assert.ok(!isBlock(c.r));
    assert.strictEqual(c.mock.calls, 0);
    assert.deepStrictEqual(c.log().map((l) => l.reason), ['loop-safe']);
  } finally { c.h.cleanup(); }
});

test('JEV: credential never appears in stdout, stderr, or the log', async () => {
  const c = await jevCase({ reply: NO_HEDGE_SPEC, respond: noul(0.97) });
  try {
    const logRaw = fs.readFileSync(path.join(c.h.home, '.anti-hall', 'logs', 'jev-judge.ndjson'), 'utf8');
    for (const s of [c.r.stdout, c.r.stderr, logRaw]) {
      assert.ok(!s.includes('jev-test-key-never-logged'));
      assert.ok(!s.includes(NO_HEDGE_SPEC), 'no message text in outputs/log');
    }
  } finally { c.h.cleanup(); }
});
