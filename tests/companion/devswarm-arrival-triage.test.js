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
