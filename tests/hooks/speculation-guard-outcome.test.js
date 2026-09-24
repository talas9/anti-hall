'use strict';
// speculation-guard.js — outcome capture (2026-09). When the PREVIOUS Stop in
// a session produced a block (Jev-added or regex), the NEXT Stop classifies
// the new reply against it and records an outcome to jev-assist's shared
// metrics log (~/.anti-hall/logs/jev-assist.ndjson), tagged with the block's
// source ('jev'|'regex') so `jev report` can compare the two.
//
// Sequences run as two REAL Stop calls against the SAME fixture home/session,
// mirroring how the hook is actually invoked turn-over-turn. The Jev leg uses
// the same async-spawn + in-process-mock-server pattern as speculation-guard's
// own JEV integration tests (spawn, not spawnSync, so the mock server's event
// loop is never blocked).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { makeHome, assistantMessage } = require('../helpers/fixtures.js');
const { HOOKS_DIR } = require('../helpers/spawn-hook.js');

const HOOK = 'speculation-guard.js';

function stopPayload(transcriptPath, sessionId) {
  return { hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: sessionId };
}

function runAsync(payloadObj, opts) {
  const env = { PATH: process.env.PATH, HOME: opts.home, ...(opts.env || {}) };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HOOKS_DIR, HOOK)], { env });
    let stdout = ''; let stderr = '';
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

function runSync(payloadObj, opts) {
  const env = { PATH: process.env.PATH, HOME: opts.home, ...(opts.env || {}) };
  const r = spawnSync(process.execPath, [path.join(HOOKS_DIR, HOOK)], { env, input: JSON.stringify(payloadObj), encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) { json = null; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function isBlock(r) {
  return r.status === 0 && r.json && r.json.decision === 'block';
}

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

// noulByEvidence(): a mock that answers "confidently speculative" UNLESS the
// state text carries a test-count/file:line evidence marker, in which case it
// answers "confidently grounded" — so a two-Stop sequence through the SAME
// mock server can exercise both a Jev-added block and its evidence-bearing
// follow-up without swapping servers mid-session.
function noulByEvidence(req, res, body) {
  const state = (body && body.state) || '';
  const grounded = /\d+ pass, \d+ fail|\.\w+:\d+/.test(state);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ answers: { decision: { noul: grounded ? 0.02 : 0.97 } } }));
}

function readOutcomeRows(home) {
  try {
    return fs.readFileSync(path.join(home, '.anti-hall', 'logs', 'jev-assist.ndjson'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'outcome');
  } catch (_) {
    return [];
  }
}

const NO_HEDGE_SPEC = 'Fixed. The race condition was in the retry loop, so the flaky test is resolved.';
const HEDGE_SPEC = 'This should be fine now.';
const EVIDENCE_REPLY = 'Ran `node --test`: 12 pass, 0 fail (see src/app.js:42).';
const STILL_SPEC = 'This is probably fine too.';

test('outcome capture: Jev-added block -> next reply with evidence -> evidence-added, source jev', async () => {
  const h = makeHome();
  const mock = await mockJev(noulByEvidence);
  try {
    h.writeState('jev.json', { enabled: true });
    const sessionId = 's1';
    const env = { AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: mock.endpoint };

    const tp1 = h.writeTranscript([assistantMessage(NO_HEDGE_SPEC)]);
    const r1 = await runAsync(stopPayload(tp1, sessionId), { home: h.home, env });
    assert.ok(isBlock(r1), 'first reply is confidently speculative -> Jev-added block');

    const tp2 = h.writeTranscript([assistantMessage(NO_HEDGE_SPEC), assistantMessage(EVIDENCE_REPLY)]);
    const r2 = await runAsync(stopPayload(tp2, sessionId), { home: h.home, env });
    assert.ok(!isBlock(r2), 'evidence-bearing reply is not itself speculative');

    const outcomes = readOutcomeRows(h.home);
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0].id, 'speculation');
    assert.strictEqual(outcomes[0].outcome, 'evidence-added');
    assert.strictEqual(outcomes[0].source, 'jev');
    assert.ok(!JSON.stringify(outcomes[0]).includes(EVIDENCE_REPLY), 'no message body in the outcome row');
  } finally {
    await mock.close();
    h.cleanup();
  }
});

test('outcome capture: regex block -> still speculative reply -> repeat-speculation, source regex', () => {
  const h = makeHome();
  try {
    const sessionId = 's2';
    const tp1 = h.writeTranscript([assistantMessage(HEDGE_SPEC)]);
    const r1 = runSync(stopPayload(tp1, sessionId), { home: h.home });
    assert.ok(isBlock(r1), 'regex-only block (Jev disabled)');

    const tp2 = h.writeTranscript([assistantMessage(HEDGE_SPEC), assistantMessage(STILL_SPEC)]);
    const r2 = runSync(stopPayload(tp2, sessionId), { home: h.home });
    assert.ok(isBlock(r2), 'second reply is still speculative -> blocks again too');

    const outcomes = readOutcomeRows(h.home);
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0].outcome, 'repeat-speculation');
    assert.strictEqual(outcomes[0].source, 'regex');
  } finally {
    h.cleanup();
  }
});

test('outcome capture: skip.json set before the next Stop -> user-override', () => {
  const h = makeHome();
  try {
    const sessionId = 's3';
    const tp1 = h.writeTranscript([assistantMessage(HEDGE_SPEC)]);
    const r1 = runSync(stopPayload(tp1, sessionId), { home: h.home });
    assert.ok(isBlock(r1));

    h.writeSkip({ 'speculation-guard': Date.now() + 600000 });
    const tp2 = h.writeTranscript([assistantMessage(HEDGE_SPEC), assistantMessage(STILL_SPEC)]);
    const r2 = runSync(stopPayload(tp2, sessionId), { home: h.home });
    assert.ok(!isBlock(r2), 'skip hatch suppresses the block');

    const outcomes = readOutcomeRows(h.home);
    assert.strictEqual(outcomes.length, 1);
    assert.strictEqual(outcomes[0].outcome, 'user-override');
    assert.strictEqual(outcomes[0].source, 'regex');
  } finally {
    h.cleanup();
  }
});

test('outcome capture: a pending record is consumed exactly once', () => {
  const h = makeHome();
  try {
    const sessionId = 's4';
    const tp1 = h.writeTranscript([assistantMessage(HEDGE_SPEC)]);
    runSync(stopPayload(tp1, sessionId), { home: h.home });

    const tp2 = h.writeTranscript([assistantMessage(HEDGE_SPEC), assistantMessage(EVIDENCE_REPLY)]);
    runSync(stopPayload(tp2, sessionId), { home: h.home });

    // Third Stop: nothing new is pending, so no second outcome row appears
    // even though the reply is again a plain non-speculative statement.
    const tp3 = h.writeTranscript([
      assistantMessage(HEDGE_SPEC), assistantMessage(EVIDENCE_REPLY), assistantMessage('Ok.'),
    ]);
    runSync(stopPayload(tp3, sessionId), { home: h.home });

    const outcomes = readOutcomeRows(h.home);
    assert.strictEqual(outcomes.length, 1, 'outcome recorded exactly once for the one block');
  } finally {
    h.cleanup();
  }
});

test('outcome capture: no prior block -> no outcome row on a clean first turn', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([assistantMessage(EVIDENCE_REPLY)]);
    runSync(stopPayload(tp, 's5'), { home: h.home });
    assert.deepStrictEqual(readOutcomeRows(h.home), []);
  } finally {
    h.cleanup();
  }
});
