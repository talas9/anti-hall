'use strict';
// devswarm-parent-inbox.js — mesh message triage on the DEVSWARM BROADCAST
// (roster/FYI) feed (Jev part 2, buildBroadcastSegment). ADVISORY ONLY: a
// tag is prefixed to a row's rendered line; nothing about which rows show,
// their order, or the Stop-gate's own unread computation ever changes.
//
// The DISABLED path (no jev.json) is exercised via the existing synchronous
// `testHook` (spawnSync) — safe, since triageMessagesSync's disabled fast
// path never touches the network. The ENABLED path needs a real (mocked)
// network round-trip, so it uses an ASYNC spawn against an in-process mock
// server — spawnSync here would deadlock this process's own event loop
// against its own mock server (same documented reason as
// tests/hooks/jev-triage.test.js and speculation-judge.test.js's
// testHookAsync).

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { testHook, HOOKS_DIR } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

// HERMETIC: testHook's isolatedEnv (POSIX) already sends only {PATH, HOME} to
// the spawned hook, and testHookAsync below does the same — neither inherits
// the developer's shell ANTIHALL_JEV/credentials. Stripped here too, for the
// same reason as the other two triage test files in this patch: belt-and-
// suspenders against a future edit that spreads process.env into a child env.
for (const k of Object.keys(process.env)) {
  if (k === 'ANTIHALL_JEV' || k.startsWith('ANTIHALL_JEV_') ||
    k === 'AI_GATEWAY_API_KEY' || k === 'TYPESAFE_API_KEY') {
    delete process.env[k];
  }
}

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function payload(sessionId) {
  return { hook_event_name: 'UserPromptSubmit', session_id: sessionId || 't', prompt: 'hi', cwd: REPO_CWD };
}
function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
function swarmDir(home) {
  const d = path.join(home, '.anti-hall', 'devswarm');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function writeSharedSummary(home, recent) {
  const dir = path.join(swarmDir(home), 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify({
    generatedAt: Date.now(), requiredGates: [], workspaces: {}, recent, archivedRegistryRows: [],
  }));
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

function testHookAsync(hookRelPath, payloadObj, opts = {}) {
  const hookAbs = path.isAbsolute(hookRelPath) ? hookRelPath : path.join(HOOKS_DIR, hookRelPath);
  const env = { PATH: process.env.PATH, HOME: opts.home, ...(opts.env || {}) };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookAbs], { env });
    let stdout = '', stderr = '';
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

test('DISABLED (no jev.json, the default): broadcast rows render with no kind tag, unchanged from before this feature', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, [{ from: 'peer-1', summary: 'can you review this PR?', ts: Date.now(), urgency: 'normal' }]);
    const r = testHook(HOOK, payload('sess-disabled'), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(c.includes('DEVSWARM BROADCAST'), c);
    assert.ok(c.includes('- peer-1: can you review this PR?'), `row must render exactly as before triage existed; ctx=${c}`);
    assert.ok(!/\[question-needs-answer\]|\[blocker\]|\[status-report\]|\[done-report\]|\[fyi\]/.test(c), c);
  } finally { h.cleanup(); }
});

test('ENABLED + confident mock Jev: the row gains an advisory [kind] tag; row set/order/count unchanged', async () => {
  const h = makeHome();
  try {
    fs.writeFileSync(path.join(h.home, '.anti-hall', 'jev.json'),
      JSON.stringify({ enabled: true, confidenceThreshold: 0.85, timeoutMs: 1000 }), 'utf8');
    writeSharedSummary(h.home, [{ from: 'peer-1', summary: 'can you review this PR?', ts: Date.now(), urgency: 'normal' }]);

    await withMockServer(async (req, res) => {
      const body = await readJsonBody(req);
      const out = { answers: {} };
      if (body.questions.kind) out.answers.kind = { choice: 'question-needs-answer', confidence: 0.95 };
      if (body.questions.urgency) out.answers.urgency = { noul: 0.02 }; // confidently NOT urgent
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    }, async (endpoint) => {
      const r = await testHookAsync(HOOK, payload('sess-enabled'), {
        home: h.home,
        env: Object.assign({}, PRIMARY_ENV, {
          ANTIHALL_JEV_TEST_ENDPOINT: endpoint,
          AI_GATEWAY_API_KEY: 'test-key',
        }),
      });
      const c = ctx(r);
      assert.ok(c.includes('DEVSWARM BROADCAST'), `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.ok(c.includes('[question-needs-answer]'), c);
      assert.ok(!c.includes('[URGENT]'), 'a confidently non-urgent row must not gain the [URGENT] tag');
      // The row's core rendering (who + body) is untouched — only a tag is prefixed.
      assert.ok(c.includes('peer-1: can you review this PR?'), c);
      // Still exactly one row, still advisory-framed, never a gate change.
      assert.strictEqual((c.match(/^- /gm) || []).length, 1);
      assert.ok(c.includes('NEVER blocks your turn'), c);
    });
  } finally { h.cleanup(); }
});
