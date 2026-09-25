'use strict';
// jev-setup.js — CLI (`enable`/`disable`/`set-key`/`status`/`test`/`mode`)
// unit + subprocess tests. Every subprocess run gets an ISOLATED HOME (never
// the real ~) and, for `test`, a local mock HTTP server standing in for the
// Vercel AI Gateway/TypeSafe endpoint (never the real network).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { makeHome } = require('../helpers/fixtures.js');

const SCRIPT = require.resolve('../../plugins/anti-hall/scripts/jev-setup.js');
const setupLib = require(SCRIPT);

function run(args, { home, input } = {}) {
  const env = Object.assign({}, process.env, { HOME: home });
  delete env.AI_GATEWAY_API_KEY;
  delete env.TYPESAFE_API_KEY;
  delete env.ANTIHALL_JEV;
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      input: input !== undefined ? input : '',
      env,
      encoding: 'utf8',
    });
    return { code: 0, stdout: out };
  } catch (err) {
    return {
      code: err.status,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

function readJevJson(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.anti-hall', 'jev.json'), 'utf8'));
}

function withMockServer(handler, fn) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      Promise.resolve(fn(`http://127.0.0.1:${port}/mock`))
        .then((v) => server.close(() => resolve(v)), (e) => server.close(() => reject(e)));
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

// ---------------------------------------------------------------------------
// set-key: stdin only, never argv, never echoed, 0600, atomic
// ---------------------------------------------------------------------------

test('set-key: writes key from stdin, mode 0600, atomic, never printed', () => {
  const { home } = makeHome();
  const r = run(['set-key'], { home, input: 'sk-real-secret-value-123\n' });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /^key saved \(24 chars\)/);
  assert.doesNotMatch(r.stdout, /sk-real-secret-value-123/);

  const keyPath = path.join(home, '.config', 'vercel', 'ai-gateway-key');
  const stat = fs.statSync(keyPath);
  assert.strictEqual(stat.mode & 0o777, 0o600);
  assert.strictEqual(fs.readFileSync(keyPath, 'utf8').trim(), 'sk-real-secret-value-123');
});

test('set-key: key never appears in argv (process list) or in stdout/stderr', () => {
  const { home } = makeHome();
  const r = run(['set-key'], { home, input: 'top-secret-argv-check\n' });
  assert.strictEqual(r.code, 0);
  assert.doesNotMatch(r.stdout, /top-secret-argv-check/);
  assert.doesNotMatch(r.stderr || '', /top-secret-argv-check/);
  // argv passed to the child was exactly ['set-key'] — the key traveled only
  // via stdin, never as a CLI argument.
});

test('set-key: empty stdin is rejected, no file written', () => {
  const { home } = makeHome();
  const r = run(['set-key'], { home, input: '' });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /no key received/);
  assert.strictEqual(fs.existsSync(path.join(home, '.config', 'vercel', 'ai-gateway-key')), false);
});

test('set-key: non-printable key content is rejected', () => {
  const { home } = makeHome();
  const r = run(['set-key'], { home, input: 'bad\x01key\n' });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /non-printable/);
});

test('set-key: --transport typesafe writes the typesafe key path and records transport', () => {
  const { home } = makeHome();
  const r = run(['set-key', '--transport', 'typesafe'], { home, input: 'ts-key-value\n' });
  assert.strictEqual(r.code, 0);
  const keyPath = path.join(home, '.config', 'typesafe', 'key');
  assert.strictEqual(fs.readFileSync(keyPath, 'utf8').trim(), 'ts-key-value');
  assert.strictEqual(readJevJson(home).transport, 'typesafe');
});

// ---------------------------------------------------------------------------
// enable / disable / merge-without-clobber
// ---------------------------------------------------------------------------

test('enable: sets enabled true, defaults transport to vercel', () => {
  const { home } = makeHome();
  const r = run(['enable'], { home });
  assert.strictEqual(r.code, 0);
  const cfg = readJevJson(home);
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.transport, 'vercel');
});

test('enable: --transport typesafe is recorded', () => {
  const { home } = makeHome();
  run(['enable', '--transport', 'typesafe'], { home });
  assert.strictEqual(readJevJson(home).transport, 'typesafe');
});

test('disable: sets enabled false without touching other fields', () => {
  const { home } = makeHome();
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.anti-hall', 'jev.json'),
    JSON.stringify({ enabled: true, transport: 'typesafe', confidenceThreshold: 0.9, costPerCall: 0.001 }),
  );
  run(['disable'], { home });
  const cfg = readJevJson(home);
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(cfg.transport, 'typesafe');
  assert.strictEqual(cfg.confidenceThreshold, 0.9);
  assert.strictEqual(cfg.costPerCall, 0.001);
});

test('mode: sets one integration without clobbering others or unrelated fields', () => {
  const { home } = makeHome();
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.anti-hall', 'jev.json'),
    JSON.stringify({ enabled: true, integrations: { speculation: 'on', modelRouting: 'shadow' }, costPerCall: 0.002 }),
  );
  const r = run(['mode', 'modelRouting', 'on'], { home });
  assert.strictEqual(r.code, 0);
  const cfg = readJevJson(home);
  assert.strictEqual(cfg.integrations.modelRouting, 'on');
  assert.strictEqual(cfg.integrations.speculation, 'on');
  assert.strictEqual(cfg.costPerCall, 0.002);
});

test('mode: writes the NEW canonical settings.json key (jevIntegrations.<id>), not the old jev.integrations.<id> location', () => {
  const { home } = makeHome();
  const r = run(['mode', 'modelRouting', 'on'], { home });
  assert.strictEqual(r.code, 0);
  const settings = require('../../plugins/anti-hall/hooks/lib/settings.js');
  assert.strictEqual(settings.get('jevIntegrations', 'modelRouting', undefined, { home }), 'on');
  assert.strictEqual(settings.source('jevIntegrations', 'modelRouting', { home }), 'file');
  const store = settings.load({ home });
  assert.ok(!store.jev || !('integrations.modelRouting' in store.jev), 'never writes the old settings.json location');
});

test('mode: rejects an invalid mode value', () => {
  const { home } = makeHome();
  const r = run(['mode', 'speculation', 'maybe'], { home });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /usage/);
});

// ---------------------------------------------------------------------------
// status: key present yes/no only (never the value), modes, call count
// ---------------------------------------------------------------------------

test('status: reports key present:no when nothing is configured', () => {
  const { home } = makeHome();
  const r = run(['status'], { home });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /enabled: false/);
  assert.match(r.stdout, /key present: no/);
});

test('status: reports key present:yes after set-key, never the value', () => {
  const { home } = makeHome();
  run(['set-key'], { home, input: 'a-real-key-value\n' });
  const r = run(['status'], { home });
  assert.match(r.stdout, /key present: yes/);
  assert.doesNotMatch(r.stdout, /a-real-key-value/);
});

test('status: shows per-integration modes with legacy defaults', () => {
  const { home } = makeHome();
  const r = run(['status'], { home });
  assert.match(r.stdout, /speculation: on/);
  assert.match(r.stdout, /triage: on/);
  assert.match(r.stdout, /modelRouting: shadow/);
});

test('status: counts last-24h calls from jev-assist.ndjson', () => {
  const { home } = makeHome();
  const logDir = path.join(home, '.anti-hall', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const lines = [
    { ts: now, id: 'speculation', backend: 'jev' },
    { ts: now, id: 'modelRouting', backend: 'cache' },
    { ts: old, id: 'speculation', backend: 'jev' },
    { ts: now, type: 'outcome', id: 'speculation', h: 'x', outcome: 'evidence-added' },
  ];
  fs.writeFileSync(path.join(logDir, 'jev-assist.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = run(['status'], { home });
  assert.match(r.stdout, /calls \(last 24h\): 2/);
});

// ---------------------------------------------------------------------------
// test verb: mock server, ok + failure paths, never prints the key
//
// Run IN-PROCESS (not spawned as a subprocess) — this sandboxed test host
// blocks outbound network from a grandchild process (node --test -> execFileSync
// child), even to 127.0.0.1; a real CI/user machine has no such restriction,
// but calling cmdTest() directly here keeps the network call at one hop
// (this process -> the in-process mock server) so the test is runnable
// everywhere. HOME and process.exitCode are saved/restored around every call
// so this never leaks into the surrounding test run.
// ---------------------------------------------------------------------------

async function runCmdTestInProcess(home, envOverrides = {}) {
  const savedHome = process.env.HOME;
  const savedGateway = process.env.AI_GATEWAY_API_KEY;
  const savedTypesafe = process.env.TYPESAFE_API_KEY;
  const savedEndpoint = process.env.ANTIHALL_JEV_TEST_ENDPOINT;
  const savedExitCode = process.exitCode;
  const savedLog = console.log;
  const savedError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  process.env.HOME = home;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.ANTIHALL_JEV_TEST_ENDPOINT;
  Object.assign(process.env, envOverrides);
  process.exitCode = 0;
  try {
    await setupLib.cmdTest();
    return { code: process.exitCode || 0, out: lines.join('\n') };
  } finally {
    console.log = savedLog;
    console.error = savedError;
    process.exitCode = savedExitCode;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedGateway === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = savedGateway;
    if (savedTypesafe === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedTypesafe;
    if (savedEndpoint === undefined) delete process.env.ANTIHALL_JEV_TEST_ENDPOINT; else process.env.ANTIHALL_JEV_TEST_ENDPOINT = savedEndpoint;
  }
}

async function runCmdStatusInProcess(home, envOverrides = {}) {
  const savedHome = process.env.HOME;
  const savedGateway = process.env.AI_GATEWAY_API_KEY;
  const savedTypesafe = process.env.TYPESAFE_API_KEY;
  const savedEndpoint = process.env.ANTIHALL_JEV_TEST_ENDPOINT;
  const savedLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  process.env.HOME = home;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.ANTIHALL_JEV_TEST_ENDPOINT;
  Object.assign(process.env, envOverrides);
  try {
    await setupLib.cmdStatus();
    return lines.join('\n');
  } finally {
    console.log = savedLog;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedGateway === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = savedGateway;
    if (savedTypesafe === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedTypesafe;
    if (savedEndpoint === undefined) delete process.env.ANTIHALL_JEV_TEST_ENDPOINT; else process.env.ANTIHALL_JEV_TEST_ENDPOINT = savedEndpoint;
  }
}

test('status: shows the credit balance against a mock /v1/credits server (vercel transport)', async () => {
  const { home } = makeHome();
  run(['set-key'], { home, input: 'mock-key-value\n' });
  run(['enable'], { home });

  await withMockServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ balance: '42.10', total_used: '7.90' }));
    },
    async (endpoint) => {
      const out = await runCmdStatusInProcess(home, { ANTIHALL_JEV_TEST_ENDPOINT: endpoint });
      assert.match(out, /credit balance: \$42\.10/);
      assert.doesNotMatch(out, /mock-key-value/);
    },
  );
});

test('status: no key configured -> no credit balance line at all (not a warning-worthy condition)', async () => {
  const { home } = makeHome();
  const out = await runCmdStatusInProcess(home);
  assert.doesNotMatch(out, /credit balance/);
});

test('test: ok path against a mock server returns confidence/latency, not the key', async () => {
  const { home } = makeHome();
  run(['set-key'], { home, input: 'mock-key-value\n' });
  run(['enable'], { home });

  await withMockServer(
    async (req, res) => {
      const body = await readJsonBody(req);
      assert.ok(body && body.questions && body.questions.decision);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: 0.95 } } }));
    },
    async (endpoint) => {
      const r = await runCmdTestInProcess(home, { ANTIHALL_JEV_TEST_ENDPOINT: endpoint });
      assert.strictEqual(r.code, 0);
      assert.match(r.out, /^ok — latency \d+ms, confidence 0\.90/);
      assert.doesNotMatch(r.out, /mock-key-value/);
    },
  );
});

test('test: reports "not enabled" without a key or a network call', () => {
  const { home } = makeHome();
  const r = run(['test'], { home });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /not enabled/);
});

test('test: no-key failure path is reported without hitting the network', async () => {
  const { home } = makeHome();
  run(['enable'], { home });
  const r = await runCmdTestInProcess(home);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /failed: no-key/);
  assert.match(r.out, /run `set-key`/);
});

test('test: http-401 failure suggests checking the provider/transport', async () => {
  const { home } = makeHome();
  run(['set-key'], { home, input: 'wrong-key\n' });
  run(['enable'], { home });

  await withMockServer(
    (req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    },
    async (endpoint) => {
      const r = await runCmdTestInProcess(home, { ANTIHALL_JEV_TEST_ENDPOINT: endpoint });
      assert.notStrictEqual(r.code, 0);
      assert.match(r.out, /failed: http-401/);
      assert.match(r.out, /provider.*transport|transport.*provider|rejected/i);
      assert.doesNotMatch(r.out, /wrong-key/);
    },
  );
});

// ---------------------------------------------------------------------------
// pure-function unit coverage (in-process)
// ---------------------------------------------------------------------------

test('isPrintable: rejects control characters, accepts normal key charset', () => {
  assert.strictEqual(setupLib.isPrintable('abc123-_.'), true);
  assert.strictEqual(setupLib.isPrintable('abc\ndef'), false);
  assert.strictEqual(setupLib.isPrintable('abc\x00def'), false);
});

test('resolveTransport: defaults to vercel, honors override and stored config', () => {
  assert.strictEqual(setupLib.resolveTransport({}), 'vercel');
  assert.strictEqual(setupLib.resolveTransport({ transport: 'typesafe' }), 'typesafe');
  assert.strictEqual(setupLib.resolveTransport({ transport: 'typesafe' }, 'vercel'), 'vercel');
});
