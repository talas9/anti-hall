'use strict';
// LABEL AT ARRIVAL (parentGateQuestion input): an un-flagged direct message that
// is ingested while Jev triage is enabled gets a `question-needs-answer` label in
// the triage cache while still UNREAD, so computeSummary's jevQuestionCandidates
// (cache-only) — the parent gate's input — carries it. An already-labelled
// message costs no extra Jev call; disabled Jev is a no-op.

require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const triage = require('../../plugins/anti-hall/hooks/lib/jev-triage.js');

function tmpHome(jev) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-arrival-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  if (jev) fs.writeFileSync(path.join(home, '.anti-hall', 'jev.json'), JSON.stringify(jev));
  return home;
}
const rm = (h) => { try { fs.rmSync(h, { recursive: true, force: true }); } catch (_) {} };
const descriptor = (id, wt) => ({ id, worktreePath: wt, sessionId: 's-' + id, inboxPath: '/i/' + id, cursorPath: '/c/' + id, nudgeCommand: null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  return fn();
}

function seedAndSend(home, text, extra) {
  const s = store.openStore({ home, backend: 'journal' });
  s.upsertRegistry(descriptor('P', '/wt/primary'));
  s.upsertRegistry(descriptor('C', '/wt/child'));
  const childMesh = inst.primaryWorkspaceId('/wt/child');
  const f = { from: childMesh, to: 'P', type: 'direct', message: text, timestamp: 1000, urgency: 'normal' };
  const res = store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f), home }, extra || {}));
  return { s, res };
}

test('arrival: an ingested unread DM is labelled and then appears in jevQuestionCandidates', async () => {
  const home = tmpHome({ enabled: true, confidenceThreshold: 0.85, timeoutMs: 2000, triageBudgetMs: 3000 });
  let hits = 0;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      hits++;
      const body = JSON.parse(raw);
      const out = { answers: {} };
      if (body.questions.kind) out.answers.kind = { choice: 'question-needs-answer', confidence: 0.95 };
      if (body.questions.urgency) out.answers.urgency = { noul: 0.05 };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = { e: process.env.ANTIHALL_JEV_TEST_ENDPOINT, k: process.env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY };
  process.env.ANTIHALL_JEV_TEST_ENDPOINT = 'http://127.0.0.1:' + server.address().port + '/mock';
  process.env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY = 'k';
  const text = 'Should I merge this now or wait for review?';
  try {
    const { s } = seedAndSend(home, text);
    try {
      const cachePath = triage.cachePath(home);
      const labelled = await waitFor(() => {
        try { return JSON.parse(fs.readFileSync(cachePath, 'utf8'))[triage.hashMessage(text)].kind === 'question-needs-answer'; } catch (_) { return false; }
      }, 8000);
      assert.ok(labelled, 'the DM is labelled at arrival, before anything renders it');
      const summary = store.computeSummary(s, { home, now: 2000 });
      const w = summary.workspaces.P;
      assert.ok(w && Array.isArray(w.jevQuestionCandidates) && w.jevQuestionCandidates.length === 1, 'unread labelled DM is a parentGateQuestion candidate');
      // a second identical arrival: already labelled -> zero extra Jev calls
      const before = hits;
      assert.strictEqual(triage.enqueueArrival({ home, text }), false);
      await sleep(300);
      assert.strictEqual(hits, before, 'no extra Jev call for an already-labelled message');
    } finally { s.close(); }
  } finally {
    server.close();
    if (saved.e === undefined) delete process.env.ANTIHALL_JEV_TEST_ENDPOINT; else process.env.ANTIHALL_JEV_TEST_ENDPOINT = saved.e;
    if (saved.k === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY; else process.env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY = saved.k;
    rm(home);
  }
});

test('arrival: Jev disabled -> no spawn, no cache; needsReply and heartbeat rows are not enqueued', () => {
  const home = tmpHome(null);
  try {
    const { s } = seedAndSend(home, 'Is this fine?');
    s.close();
    assert.ok(!fs.existsSync(triage.cachePath(home)), 'disabled path never touches the cache');
    assert.strictEqual(triage.enqueueArrival({ home, text: 'x' }), false);
    assert.strictEqual(triage.enqueueArrival({ text: 'x' }), false, 'no home -> no-op');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// BOUNDED: one drain worker per HOME, whatever the burst size.
// ---------------------------------------------------------------------------
async function withEnvMock(delayMs, fn) {
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const out = { answers: {} };
      if (body.questions.kind) out.answers.kind = { choice: 'fyi', confidence: 0.95 };
      if (body.questions.urgency) out.answers.urgency = { noul: 0.05 };
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); }, delayMs);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const keys = ['ANTIHALL_JEV_TEST_ENDPOINT', 'CLAUDE_PLUGIN_OPTION_JEV_API_KEY', 'ANTIHALL_TRIAGE_ARRIVAL_TRACE'];
  const saved = keys.map((k) => process.env[k]);
  const trace = path.join(os.tmpdir(), 'arrival-trace-' + process.pid + '-' + Date.now());
  process.env.ANTIHALL_JEV_TEST_ENDPOINT = 'http://127.0.0.1:' + server.address().port + '/mock';
  process.env.CLAUDE_PLUGIN_OPTION_JEV_API_KEY = 'k';
  process.env.ANTIHALL_TRIAGE_ARRIVAL_TRACE = trace;
  try { return await fn(trace); } finally {
    server.close();
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    try { fs.unlinkSync(trace); } catch (_) {}
  }
}
function traceStats(trace) {
  let lines = [];
  try { lines = fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')); } catch (_) {}
  let alive = 0, maxAlive = 0, spawns = 0;
  for (const [ev] of lines) {
    if (ev === 'spawn') spawns++;
    if (ev === 'start') { alive++; maxAlive = Math.max(maxAlive, alive); }
    if (ev === 'end') alive--;
  }
  return { spawns, maxAlive, alive };
}

test('burst of 50 direct sends: <=1 worker alive at a time, tiny spawn count, every message labelled, queue/lock drained', async () => {
  const home = tmpHome({ enabled: true, confidenceThreshold: 0.85, timeoutMs: 2000, triageBudgetMs: 3000 });
  await withEnvMock(60, async (trace) => {
    const s = store.openStore({ home, backend: 'journal' });
    try {
      s.upsertRegistry(descriptor('P', '/wt/primary'));
      s.upsertRegistry(descriptor('C', '/wt/child'));
      const childMesh = inst.primaryWorkspaceId('/wt/child');
      const texts = [];
      const t0 = Date.now();
      for (let i = 0; i < 50; i++) {
        const text = 'burst message number ' + i;
        texts.push(text);
        const f = { from: childMesh, to: 'P', type: 'direct', message: text, timestamp: 1000 + i, urgency: 'normal' };
        store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f), home }));
      }
      const sendMs = Date.now() - t0;
      const done = await waitFor(() => {
        try {
          const c = JSON.parse(fs.readFileSync(triage.cachePath(home), 'utf8'));
          return texts.every((t) => c[triage.hashMessage(t)]);
        } catch (_) { return false; }
      }, 60000);
      assert.ok(done, 'all 50 messages end up labelled or cached');
      await waitFor(() => !fs.existsSync(triage.arrivalLockPath(home)), 5000);
      const st = traceStats(trace);
      console.log('burst: sendMs=' + sendMs + ' spawns=' + st.spawns + ' maxAlive=' + st.maxAlive);
      assert.ok(st.maxAlive <= 1, 'never more than one worker alive (got ' + st.maxAlive + ')');
      assert.ok(st.spawns >= 1 && st.spawns <= 3, 'a small constant number of spawns (got ' + st.spawns + ')');
      assert.ok(!fs.existsSync(triage.arrivalLockPath(home)), 'lock released');
      assert.ok(!fs.existsSync(triage.arrivalQueuePath(home)) || fs.statSync(triage.arrivalQueuePath(home)).size === 0, 'queue drained');
    } finally { s.close(); rm(home); }
  });
});

test('stale arrival lock (dead worker) is reclaimed: the next arrival spawns and gets labelled', async () => {
  const home = tmpHome({ enabled: true, confidenceThreshold: 0.85, timeoutMs: 2000, triageBudgetMs: 3000 });
  await withEnvMock(10, async (trace) => {
    try {
      fs.mkdirSync(path.join(home, '.anti-hall', 'cache'), { recursive: true });
      const lock = triage.arrivalLockPath(home);
      fs.writeFileSync(lock, '999999');
      const old = new Date(Date.now() - triage.ARRIVAL_LOCK_STALE_MS - 5000);
      fs.utimesSync(lock, old, old);
      assert.strictEqual(triage.enqueueArrival({ home, text: 'recover me please' }), true);
      assert.ok(await waitFor(() => { try { return !!JSON.parse(fs.readFileSync(triage.cachePath(home), 'utf8'))[triage.hashMessage('recover me please')]; } catch (_) { return false; } }, 15000));
      assert.strictEqual(traceStats(trace).spawns, 1);
    } finally { rm(home); }
  });
});

test('a FRESH lock means no spawn at all (a live worker will drain the queue)', async () => {
  const home = tmpHome({ enabled: true, confidenceThreshold: 0.85, timeoutMs: 2000 });
  await withEnvMock(10, async (trace) => {
    try {
      fs.mkdirSync(path.join(home, '.anti-hall', 'cache'), { recursive: true });
      fs.writeFileSync(triage.arrivalLockPath(home), String(process.pid));
      assert.strictEqual(triage.enqueueArrival({ home, text: 'queued behind a live worker' }), true);
      assert.strictEqual(traceStats(trace).spawns, 0);
      assert.ok(fs.statSync(triage.arrivalQueuePath(home)).size > 0, 'message waits in the queue');
    } finally { rm(home); }
  });
});

test('arrival queue is bounded: over the cap new arrivals are dropped, file never grows past cap + one entry', () => {
  const home = tmpHome({ enabled: true, confidenceThreshold: 0.85, timeoutMs: 2000 });
  try {
    fs.mkdirSync(path.join(home, '.anti-hall', 'cache'), { recursive: true });
    fs.writeFileSync(triage.arrivalLockPath(home), String(process.pid)); // live worker: nothing spawns
    fs.writeFileSync(triage.arrivalQueuePath(home), 'x'.repeat(triage.ARRIVAL_QUEUE_MAX_BYTES + 10));
    const before = fs.statSync(triage.arrivalQueuePath(home)).size;
    assert.strictEqual(triage.enqueueArrival({ home, text: 'dropped, queue is full' }), false);
    assert.strictEqual(fs.statSync(triage.arrivalQueuePath(home)).size, before);
  } finally { rm(home); }
});
