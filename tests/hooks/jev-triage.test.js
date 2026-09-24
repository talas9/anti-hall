'use strict';
// jev-triage.js — mesh message triage, ADVISORY ONLY. Unit tests run
// in-process (safe: the disabled/no-home fast paths never touch fs/network,
// so they can never deadlock against an in-process mock server). Any test
// that needs a live (mocked) Jev round-trip SPAWNS a small wrapper script
// (async `spawn`, not `spawnSync`) — triageMessagesSync itself calls
// execFileSync internally, and calling it directly in THIS process while
// also hosting the mock server in THIS process would deadlock this process's
// own event loop (the mock server could never service the request). See
// speculation-judge.test.js's testHookAsync for the same documented pattern.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// HERMETIC: several tests below call loadTriageConfig/triageMessagesSync
// IN-PROCESS (not spawned) — jev-client.js's loadJevConfig (which they call
// through) reads process.env directly, same convention as every other Jev
// consumer. A developer's shell exporting ANTIHALL_JEV=0/1 (or a real
// AI_GATEWAY_API_KEY/TYPESAFE_API_KEY) must never change this suite's
// outcome. `node --test` runs each test FILE in its own process, so
// deleting these once at load time is sufficient for the whole file —
// nothing else in this process needs them. Any env object a test builds for
// a SPAWNED child (this file's runTriageInSubprocess, or a caller's own
// Object.assign({}, process.env, ...)) picks this up for free.
for (const k of Object.keys(process.env)) {
  if (k === 'ANTIHALL_JEV' || k.startsWith('ANTIHALL_JEV_') ||
    k === 'AI_GATEWAY_API_KEY' || k === 'TYPESAFE_API_KEY') {
    delete process.env[k];
  }
}

const LIB = require.resolve('../../plugins/anti-hall/hooks/lib/jev-triage.js');
const { triageMessagesSync, loadTriageConfig, hashMessage, noteLabeledInbound, recordAnswered } = require(LIB);

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-triage-test-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
function writeJevConfig(home, cfg) {
  fs.writeFileSync(path.join(home, '.anti-hall', 'jev.json'), JSON.stringify(cfg), 'utf8');
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

// runTriageInSubprocess(home, env, items) -> [[key,label],...] via a wrapper
// script that just requires jev-triage.js and calls triageMessagesSync. Runs
// as a real child process so its own execFileSync-spawned worker can reach a
// mock server hosted in THIS (the test) process without deadlocking anything.
function runTriageInSubprocess(home, extraEnv, items) {
  const wrapper = `
    const { triageMessagesSync } = require(${JSON.stringify(LIB)});
    const items = ${JSON.stringify(items)};
    const r = triageMessagesSync(items, { home: ${JSON.stringify(home)} });
    process.stdout.write(JSON.stringify([...r.entries()]));
  `;
  const env = Object.assign({ PATH: process.env.PATH }, extraEnv);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', wrapper], { env });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', () => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (_) { parsed = null; }
      resolve({ parsed, out, err });
    });
  });
}

// ---------------------------------------------------------------------------
// Disabled / safety fast paths — always in-process, never touch fs beyond
// what's asserted, never spawn a subprocess.
// ---------------------------------------------------------------------------

test('triageMessagesSync: no jev.json -> empty Map, no cache/log files created', () => {
  const home = tmpHome();
  try {
    const r = triageMessagesSync([{ key: 'a', text: 'hello' }], { home });
    assert.strictEqual(r.size, 0);
    assert.ok(!fs.existsSync(path.join(home, '.anti-hall', 'cache', 'jev-triage.json')));
    assert.ok(!fs.existsSync(path.join(home, '.anti-hall', 'logs', 'jev-triage.ndjson')));
  } finally { rm(home); }
});

test('triageMessagesSync: jev.json enabled:true but triage:false -> disabled (per-feature key)', () => {
  const home = tmpHome();
  try {
    writeJevConfig(home, { enabled: true, triage: false });
    const r = triageMessagesSync([{ key: 'a', text: 'hello' }], { home });
    assert.strictEqual(r.size, 0);
  } finally { rm(home); }
});

test('triageMessagesSync: jev.json enabled:true, no triage key -> triage defaults ON', () => {
  const home = tmpHome();
  try {
    writeJevConfig(home, { enabled: true });
    const cfg = loadTriageConfig(home);
    assert.strictEqual(cfg.enabled, true);
  } finally { rm(home); }
});

test('SAFETY: no `home` in opts -> empty Map immediately, ZERO fs access (never falls back to the real machine home)', () => {
  // No home passed at all — this must NEVER read the real os.homedir()'s
  // ~/.anti-hall/jev.json. We can't easily assert "no fs call happened"
  // directly, but we CAN assert the behavior is indistinguishable from
  // disabled regardless of what the real machine's jev.json says.
  const r = triageMessagesSync([{ key: 'a', text: 'hello' }], {});
  assert.strictEqual(r.size, 0);
  const r2 = triageMessagesSync([{ key: 'a', text: 'hello' }]);
  assert.strictEqual(r2.size, 0);
});

test('triageMessagesSync: empty/non-array items -> empty Map, no config read', () => {
  const home = tmpHome();
  try {
    assert.strictEqual(triageMessagesSync([], { home }).size, 0);
    assert.strictEqual(triageMessagesSync(null, { home }).size, 0);
  } finally { rm(home); }
});

test('hashMessage: stable for identical text, distinct for different text', () => {
  assert.strictEqual(hashMessage('hello'), hashMessage('hello'));
  assert.notStrictEqual(hashMessage('hello'), hashMessage('hello!'));
});

// ---------------------------------------------------------------------------
// Live-mocked Jev round trip (subprocess wrapper — see header comment).
// ---------------------------------------------------------------------------

test('enabled + confident Jev mock -> labels resolved, cached, logged (hash+labels+backend+ms, never the body)', async () => {
  const home = tmpHome();
  try {
    writeJevConfig(home, { enabled: true, confidenceThreshold: 0.85, timeoutMs: 1000 });
    await withMockServer(async (req, res) => {
      const body = await readJsonBody(req);
      const out = { answers: {} };
      if (body.questions.kind) out.answers.kind = { choice: 'question-needs-answer', confidence: 0.95 };
      if (body.questions.urgency) out.answers.urgency = { noul: 0.97 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    }, async (endpoint) => {
      const env = {
        HOME: home,
        ANTIHALL_JEV_TEST_ENDPOINT: endpoint,
        AI_GATEWAY_API_KEY: 'test-key',
      };
      const secretText = 'Can you review this PR please? [SECRET_BODY_MARKER]';
      const { parsed } = await runTriageInSubprocess(home, env, [{ key: 'm1', text: secretText }]);
      assert.ok(Array.isArray(parsed));
      assert.deepStrictEqual(parsed, [['m1', { urgency: 'urgent', kind: 'question-needs-answer' }]]);

      const logRaw = fs.readFileSync(path.join(home, '.anti-hall', 'logs', 'jev-triage.ndjson'), 'utf8');
      assert.ok(!logRaw.includes('SECRET_BODY_MARKER'), 'log must never contain the message body');
      assert.ok(!logRaw.includes('test-key'), 'log must never contain the credential');
      const entry = JSON.parse(logRaw.trim());
      assert.strictEqual(entry.urgency, 'urgent');
      assert.strictEqual(entry.kind, 'question-needs-answer');
      assert.strictEqual(entry.backend, 'jev');
      assert.ok(Number.isFinite(entry.ms));
      assert.strictEqual(entry.hash, hashMessage(secretText));

      const cacheRaw = fs.readFileSync(path.join(home, '.anti-hall', 'cache', 'jev-triage.json'), 'utf8');
      assert.ok(!cacheRaw.includes('SECRET_BODY_MARKER'), 'cache must never contain the message body');
    });
  } finally { rm(home); }
});

test('cache hit: a second call with the SAME text never issues a second request', async () => {
  const home = tmpHome();
  try {
    writeJevConfig(home, { enabled: true, confidenceThreshold: 0.85, timeoutMs: 1000 });
    let hitCount = 0;
    await withMockServer(async (req, res) => {
      hitCount++;
      const body = await readJsonBody(req);
      const out = { answers: {} };
      if (body.questions.kind) out.answers.kind = { choice: 'fyi', confidence: 0.9 };
      if (body.questions.urgency) out.answers.urgency = { noul: 0.05 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    }, async (endpoint) => {
      const env = { HOME: home, ANTIHALL_JEV_TEST_ENDPOINT: endpoint, AI_GATEWAY_API_KEY: 'k' };
      const items = [{ key: 'm1', text: 'status update, nothing needed' }];
      const r1 = await runTriageInSubprocess(home, env, items);
      const r2 = await runTriageInSubprocess(home, env, items);
      assert.deepStrictEqual(r1.parsed, [['m1', { urgency: 'normal', kind: 'fyi' }]]);
      assert.deepStrictEqual(r2.parsed, [['m1', { urgency: 'normal', kind: 'fyi' }]]);
      assert.strictEqual(hitCount, 1, 'second run must be served entirely from cache');
    });
  } finally { rm(home); }
});

test('low confidence + no ANTHROPIC_API_KEY -> no label at all (fail-open, neither backend available)', async () => {
  const home = tmpHome();
  try {
    writeJevConfig(home, { enabled: true, confidenceThreshold: 0.85, timeoutMs: 1000 });
    await withMockServer(async (req, res) => {
      const body = await readJsonBody(req);
      const out = { answers: {} };
      if (body.questions.kind) out.answers.kind = { choice: 'fyi', confidence: 0.3 }; // below threshold
      if (body.questions.urgency) out.answers.urgency = { noul: 0.55 }; // confidence 0.1, below threshold
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    }, async (endpoint) => {
      const env = { HOME: home, ANTIHALL_JEV_TEST_ENDPOINT: endpoint, AI_GATEWAY_API_KEY: 'k' };
      // deliberately no ANTHROPIC_API_KEY in env
      const { parsed } = await runTriageInSubprocess(home, env, [{ key: 'm1', text: 'ambiguous message' }]);
      assert.deepStrictEqual(parsed, [], 'no label should be attached when both backends are unusable');
    });
  } finally { rm(home); }
});

test('urgent threshold is STRICTER than the ordinary confidence threshold (known Jev over-flag weakness)', async () => {
  const home = tmpHome();
  try {
    // confidenceThreshold 0.85 (ordinary), but urgency noul=0.9 -> confidence 0.8,
    // which clears the ordinary threshold but NOT the stricter default urgent
    // threshold (0.9). Expect: kind resolves (0.95 conf), urgency does NOT.
    writeJevConfig(home, { enabled: true, confidenceThreshold: 0.85, timeoutMs: 1000 });
    await withMockServer(async (req, res) => {
      const body = await readJsonBody(req);
      const out = { answers: {} };
      if (body.questions.kind) out.answers.kind = { choice: 'status-report', confidence: 0.95 };
      if (body.questions.urgency) out.answers.urgency = { noul: 0.9 }; // confidence 0.8 < urgentThreshold 0.9
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    }, async (endpoint) => {
      const env = { HOME: home, ANTIHALL_JEV_TEST_ENDPOINT: endpoint, AI_GATEWAY_API_KEY: 'k' };
      const { parsed } = await runTriageInSubprocess(home, env, [{ key: 'm1', text: 'borderline urgency' }]);
      assert.strictEqual(parsed.length, 1);
      assert.strictEqual(parsed[0][1].kind, 'status-report');
      assert.strictEqual(parsed[0][1].urgency, undefined, 'urgency must NOT be labeled at 0.8 confidence (stricter 0.9 threshold)');
    });
  } finally { rm(home); }
});

test('timeout: server never responds -> no label, run stays within the configured budget', async () => {
  const home = tmpHome();
  try {
    writeJevConfig(home, { enabled: true, timeoutMs: 500, triageBudgetMs: 800 });
    await withMockServer((req, res) => { /* never respond */ }, async (endpoint) => {
      const env = { HOME: home, ANTIHALL_JEV_TEST_ENDPOINT: endpoint, AI_GATEWAY_API_KEY: 'k' };
      const start = Date.now();
      const { parsed } = await runTriageInSubprocess(home, env, [{ key: 'm1', text: 'will time out' }]);
      const elapsed = Date.now() - start;
      assert.deepStrictEqual(parsed, []);
      assert.ok(elapsed < 5000, `expected to stay well within budget, took ${elapsed}ms`);
    });
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// noteLabeledInbound / recordAnswered — answer-latency tracking (outcome #4)
// ---------------------------------------------------------------------------

test('recordAnswered: logs time-to-answer + a joinable jev-assist outcome row when a pending labeled inbound exists', () => {
  const home = tmpHome();
  try {
    noteLabeledInbound({ home, recipient: 'me', sender: 'them', label: { urgency: 'urgent' } });
    recordAnswered({ home, from: 'me', to: 'them' });

    const triageLogPath = path.join(home, '.anti-hall', 'logs', 'jev-triage.ndjson');
    const rows = fs.readFileSync(triageLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const answered = rows.find((r) => r.type === 'answered');
    assert.ok(answered, 'expected an {type:"answered"} row in jev-triage.ndjson');
    assert.strictEqual(answered.urgency, 'urgent');
    assert.ok(Number.isFinite(answered.latencyMs) && answered.latencyMs >= 0);

    const assistLogPath = path.join(home, '.anti-hall', 'logs', 'jev-assist.ndjson');
    const assistRows = fs.readFileSync(assistLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const outcome = assistRows.find((r) => r.type === 'outcome' && r.id === 'triage');
    assert.ok(outcome, 'expected a joinable {type:"outcome", id:"triage"} row in jev-assist.ndjson');
    assert.strictEqual(outcome.outcome, 'answered');
  } finally { rm(home); }
});

test('recordAnswered: no pending inbound -> no-op, no files created', () => {
  const home = tmpHome();
  try {
    recordAnswered({ home, from: 'me', to: 'nobody-ever-messaged' });
    assert.strictEqual(fs.existsSync(path.join(home, '.anti-hall', 'logs', 'jev-triage.ndjson')), false);
  } finally { rm(home); }
});

test('recordAnswered: clears the pending entry (a second send does not re-log)', () => {
  const home = tmpHome();
  try {
    noteLabeledInbound({ home, recipient: 'me', sender: 'them', label: { kind: 'blocker' } });
    recordAnswered({ home, from: 'me', to: 'them' });
    recordAnswered({ home, from: 'me', to: 'them' });
    const rows = fs.readFileSync(path.join(home, '.anti-hall', 'logs', 'jev-triage.ndjson'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(rows.filter((r) => r.type === 'answered').length, 1, 'second send must not double-log');
  } finally { rm(home); }
});

test('noteLabeledInbound: an unlabeled message (no urgency/kind) never creates a pending entry', () => {
  const home = tmpHome();
  try {
    noteLabeledInbound({ home, recipient: 'me', sender: 'them', label: {} });
    recordAnswered({ home, from: 'me', to: 'them' });
    assert.strictEqual(fs.existsSync(path.join(home, '.anti-hall', 'logs', 'jev-triage.ndjson')), false);
  } finally { rm(home); }
});
