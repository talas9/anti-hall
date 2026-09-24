'use strict';
// devswarm CLI (scripts/devswarm.js) — mesh message triage integration on
// `inbox messages` / `read-primary` / `peek-primary` output (Jev part 2).
//
// The DISABLED path is exercised in-process via cli.run (fast, safe — no
// jev.json means triageMessagesSync's fast path never touches fs beyond a
// single failed jev.json read, matching every other CLI test in this repo).
//
// The ENABLED path SPAWNS `devswarm.js` as a real child process (`node
// devswarm.js inbox messages ... --json`) against a mock Jev HTTP server
// hosted in THIS test process. This is required, not stylistic: triage's
// worker runs via execFileSync from WITHIN the CLI process, and if the CLI
// itself ran in-process (cli.run) in the SAME process as the mock server,
// that process's own event loop would be blocked by its own synchronous
// execFileSync call and could never service the mock server's HTTP request
// (see tests/hooks/jev-triage.test.js's header comment for the same
// documented deadlock and its fix).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// HERMETIC: both the in-process `cli.run` (DISABLED test, reads
// process.env.ANTIHALL_JEV directly the same way jev-client.js does) and the
// spawned child (ENABLED test, whose env is built via
// `Object.assign({}, process.env, ...)`) must be immune to the developer's
// own shell exporting ANTIHALL_JEV=0/1 or a real credential. `node --test`
// runs each test FILE in its own process, so stripping these once at load
// time covers both — the spawned child then inherits a clean process.env.
for (const k of Object.keys(process.env)) {
  if (k === 'ANTIHALL_JEV' || k.startsWith('ANTIHALL_JEV_') ||
    k === 'AI_GATEWAY_API_KEY' || k === 'TYPESAFE_API_KEY') {
    delete process.env[k];
  }
}

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

const CLI_PATH = require.resolve('../../plugins/anti-hall/scripts/devswarm.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-jevtriage-cli-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
function fakeCwd(home) {
  const p = path.join(home, 'no-git-here');
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function seedStore(home, id, bodies) {
  const s = storeLib.openStore({ home, workspaceId: id, backend: 'journal' });
  try { bodies.forEach((b, i) => s.appendMessage({ workspaceId: id, body: b, hash: id + '-h' + i })); }
  finally { s.close(); }
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

function spawnCli(argv, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...argv], { env, cwd });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', () => {
      let json = null;
      try { json = JSON.parse(out); } catch (_) { json = null; }
      resolve({ out, err, json });
    });
  });
}

test('DISABLED (no jev.json, the default): messages output carries no `triage` key on any row', () => {
  const home = tmpHome();
  try {
    seedStore(home, 'primary-x', ['can you review this?']);
    const r = cli.run(['inbox', 'messages', 'primary-x'],
      { home, backend: 'journal', env: {}, cwd: fakeCwd(home) });
    assert.equal(r.result.ok, true);
    assert.equal(r.result.count, 1);
    assert.ok(!('triage' in r.result.messages[0]), 'no triage key when triage is disabled (the default)');
  } finally { rm(home); }
});

test('ENABLED + confident mock Jev: messages carry an advisory `triage` label; unreadCount/cursor UNCHANGED vs. disabled', async () => {
  const home = tmpHome();
  try {
    seedStore(home, 'primary-x', ['Can you review this PR before I merge?']);
    fs.writeFileSync(path.join(home, '.anti-hall', 'jev.json'),
      JSON.stringify({ enabled: true, confidenceThreshold: 0.85, timeoutMs: 1000 }), 'utf8');

    // Baseline: what the SAME read reports with triage disabled (no jev.json)
    // — used to prove triage never changes unreadCount/cursor/total/count.
    const baselineHome = tmpHome();
    seedStore(baselineHome, 'primary-x', ['Can you review this PR before I merge?']);
    const baseline = cli.run(['inbox', 'messages', 'primary-x'],
      { home: baselineHome, backend: 'journal', env: {}, cwd: fakeCwd(baselineHome) }).result;
    rm(baselineHome);

    await withMockServer(async (req, res) => {
      const body = await readJsonBody(req);
      const out = { answers: {} };
      if (body.questions.kind) out.answers.kind = { choice: 'question-needs-answer', confidence: 0.95 };
      if (body.questions.urgency) out.answers.urgency = { noul: 0.97 }; // confidence 0.94, safely clears the 0.9 urgent threshold
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    }, async (endpoint) => {
      const env = Object.assign({}, process.env, {
        HOME: home,
        ANTIHALL_JEV_TEST_ENDPOINT: endpoint,
        AI_GATEWAY_API_KEY: 'test-key',
        // Match seedStore's explicit 'journal' backend — the spawned CLI (no
        // ctx0 override available from argv) otherwise defaults to whatever
        // devswarm-store.js auto-selects, which can differ from 'journal' and
        // makes it look at the wrong on-disk store entirely.
        ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal',
      });
      delete env.DEVSWARM_BUILDER_ID;
      const { json, out, err } = await spawnCli(['inbox', 'messages', 'primary-x'], env, fakeCwd(home));
      if (!json) throw new Error('CLI produced no JSON. stdout=' + out + ' stderr=' + err);
      if (!json.ok) throw new Error('CLI reported not-ok: ' + JSON.stringify(json) + ' stderr=' + err);
      assert.ok(json, 'CLI must emit parsable JSON');
      assert.equal(json.ok, true);
      assert.equal(json.count, 1);
      assert.deepStrictEqual(json.messages[0].triage, { urgency: 'urgent', kind: 'question-needs-answer' });

      // The advisory label must never change count/cursor/total/unreadCount —
      // same fields, same values, as the disabled baseline.
      assert.equal(json.count, baseline.count);
      assert.equal(json.total, baseline.total);
      assert.equal(json.cursor, baseline.cursor);
      assert.equal(json.unreadCount, baseline.unreadCount);
      // Every OTHER field on the message row is untouched (triage is additive-only).
      // `ts` is excluded: it's stamped by two SEPARATE seedStore() calls (one per
      // home) at slightly different wall-clock moments, not something triage
      // could affect.
      const { triage, ts, ...withoutTriage } = json.messages[0];
      const { ts: baselineTs, ...baselineWithoutTs } = baseline.messages[0];
      assert.deepStrictEqual(withoutTriage, baselineWithoutTs);
    });
  } finally { rm(home); }
});
