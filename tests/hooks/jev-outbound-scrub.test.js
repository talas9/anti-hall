'use strict';
// Outbound secret scrub: free text sent to the Jev gateway (ask, askSync,
// askDetached via ask, triage worker) must not carry raw token shapes.
// Obviously fake values of realistic shapes only.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeHome } = require('../helpers/fixtures.js');

const HOOKS = path.resolve(__dirname, '../../plugins/anti-hall/hooks');
const LIB = require.resolve(HOOKS + '/lib/jev-assist.js');
const CLIENT_LIB = require.resolve(HOOKS + '/lib/jev-client.js');
const WORKER = HOOKS + '/lib/jev-triage-worker.js';

const FAKES = [
  'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE',
  'ghp_FAKEFAKEFAKEFAKEFAKEFAKE1234',
  'AKIAFAKEFAKEFAKE1234',
  'Bearer fakeBearerTokenValue123',
  'password=hunter2fake',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEFAKEFAKE\n-----END RSA PRIVATE KEY-----',
];
const RAW = ['sk-ant-api03-FAKEFAKE', 'ghp_FAKEFAKE', 'AKIAFAKEFAKEFAKE1234',
  'fakeBearerTokenValue123', 'hunter2fake', 'BEGIN RSA PRIVATE KEY', 'MIIFAKEFAKEFAKE'];
const PLAIN = 'Please refactor the parser, then run the tests and report.';
const STATE = PLAIN + ' ' + FAKES.join(' ');
const NOUL_Q = { type: 'noul', instructions: 'Is the statement above true?' };

function assertClean(body, label) {
  for (const r of RAW) assert.ok(!body.includes(r), `${label}: body leaks ${r}`);
  assert.ok(body.includes(PLAIN), `${label}: surrounding text preserved`);
  assert.ok(body.includes('[REDACTED'), `${label}: placeholder present`);
}

const ENV_KEYS = ['HOME', 'ANTIHALL_JEV', 'AI_GATEWAY_API_KEY', 'ANTIHALL_JEV_TEST_ENDPOINT'];
async function withEnv(o, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, o);
    return await fn();
  } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function capture(bodies) {
  return (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      bodies.push(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: 0.1 }, kind: { choice: 'fyi', confidence: 0.99 }, urgency: { choice: 'normal', confidence: 0.99 } } }));
    });
  };
}

function withServer(handler, fn) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      Promise.resolve(fn(`http://127.0.0.1:${server.address().port}/mock`))
        .then((v) => server.close(() => resolve(v))).catch((e) => server.close(() => reject(e)));
    });
  });
}

test('ask(): outbound body has secrets redacted, plain text and question intact', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000 });
    const bodies = [];
    await withServer(capture(bodies), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        delete require.cache[LIB]; delete require.cache[CLIENT_LIB];
        const { ask } = require(LIB);
        await ask({ id: 'speculation', question: NOUL_Q, state: STATE, trust: 'add-block', baseline: false });
      });
    });
    assert.strictEqual(bodies.length, 1);
    assertClean(bodies[0], 'ask');
    const parsed = JSON.parse(bodies[0]);
    assert.deepStrictEqual(parsed.questions.decision, NOUL_Q);
    assert.strictEqual((bodies[0].match(/\[REDACTED_PEM\]/g) || []).length, 1, 'scrubbed exactly once (no double placeholder)');
  } finally { h.cleanup(); }
});

test('ask(): non-secret text is sent unchanged', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000 });
    const bodies = [];
    await withServer(capture(bodies), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        delete require.cache[LIB]; delete require.cache[CLIENT_LIB];
        await require(LIB).ask({ id: 'speculation', question: NOUL_Q, state: PLAIN, trust: 'add-block', baseline: false });
      });
    });
    assert.strictEqual(JSON.parse(bodies[0]).state, PLAIN);
  } finally { h.cleanup(); }
});

test('askSync(): outbound body (via worker subprocess) has secrets redacted', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000 });
    // Mock server must live in its own process: askSync blocks this event loop.
    const out = path.join(h.home, 'bodies.ndjson');
    const srv = spawn(process.execPath, ['-e', `
      const http=require('http'),fs=require('fs');
      http.createServer((q,s)=>{let r='';q.on('data',c=>r+=c);q.on('end',()=>{fs.appendFileSync(${JSON.stringify(out)},r+'\\n');
      s.writeHead(200,{'Content-Type':'application/json'});s.end(JSON.stringify({answers:{decision:{noul:0.1}}}));});})
      .listen(0,'127.0.0.1',function(){console.log(this.address().port);});`], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      const port = await new Promise((res) => srv.stdout.once('data', (d) => res(String(d).trim())));
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: `http://127.0.0.1:${port}/mock` }, async () => {
        delete require.cache[LIB]; delete require.cache[CLIENT_LIB];
        require(LIB).askSync({ id: 'speculation', question: NOUL_Q, state: STATE, trust: 'add-block', baseline: false });
      });
    } finally { srv.kill(); }
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    assertClean(lines[0], 'askSync');
  } finally { h.cleanup(); }
});

test('triage worker: Jev request body has secrets redacted', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000 });
    const bodies = [];
    await withServer(capture(bodies), async (endpoint) => {
      await new Promise((resolve) => {
        const env = Object.assign({}, process.env, { HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint });
        const p = spawn(process.execPath, [WORKER], { env, stdio: ['pipe', 'ignore', 'ignore'] });
        p.on('close', resolve);
        p.stdin.end(JSON.stringify({ items: [{ hash: 'h1', text: STATE }], timeoutMs: 3000 }));
      });
    });
    assert.ok(bodies.length >= 1);
    assertClean(bodies[0], 'triage');
  } finally { h.cleanup(); }
});
