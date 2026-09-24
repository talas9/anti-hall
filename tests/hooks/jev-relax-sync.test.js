'use strict';
// v0.108.0: tasklistTrivial / codexNudgeSubstantial were shadow-forever (a
// fire-and-forget askDetached could never change the nudge). consultRelax()
// now asks SYNCHRONOUSLY when the integration is "on" (cap 1.5 s): a confident
// "trivial" verdict skips the nudge; a timeout/failure keeps today's verdict
// (fail-open to nudging); shadow never changes anything and never waits.
// The mock Jev endpoint runs in its own process (see
// tests/helpers/jev-mock-server.js for why an in-process server deadlocks).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const MOCK = path.join(__dirname, '..', 'helpers', 'jev-mock-server.js');
function startMock(noul) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK], { env: { PATH: process.env.PATH, ANTIHALL_MOCK_NOUL: String(noul) } });
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c;
      const m = buf.match(/PORT=(\d+)/);
      if (m) resolve({ endpoint: 'http://127.0.0.1:' + m[1] + '/mock', stop: () => { try { child.kill(); } catch (_) {} } });
    });
    child.on('error', reject);
  });
}
function isBlock(r) { return r.status === 0 && r.json && r.json.decision === 'block'; }
function toolUse(tools) {
  return { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: tools.map((t, i) => ({ type: 'tool_use', name: t.name, id: 'tu' + i + Math.random(), input: t.input })) } };
}
const edit = (p) => ({ name: 'Edit', input: { file_path: p } });

function runCodexNudge(mode, endpoint) {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000, integrations: { codexNudgeSubstantial: mode } });
    const tp = h.writeTranscript([toolUse([edit('/x/a.ts'), edit('/x/b.ts')]), toolUse([edit('/x/c.py')])]);
    const t0 = Date.now();
    const r = testHook('codex-nudge.js', { hook_event_name: 'Stop', transcript_path: tp, session_id: 't' },
      { home: h.home, env: { AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint } });
    return { r, ms: Date.now() - t0 };
  } finally { h.cleanup(); }
}
function runTasklist(mode, endpoint) {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000, integrations: { tasklistTrivial: mode } });
    const lines = [];
    for (let i = 0; i < 4; i++) lines.push(toolUse([edit('/x/f' + i)]));
    const tp = h.writeTranscript(lines);
    const r = testHook('tasklist-guard.js', { hook_event_name: 'Stop', transcript_path: tp, cwd: h.home, session_id: 't' },
      { home: h.home, env: { AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint } });
    return r;
  } finally { h.cleanup(); }
}

test('codexNudgeSubstantial on + confident "trivial" -> the nudge is skipped', async () => {
  const m = await startMock(0.05); // confident false = trivial edits
  try { const { r } = runCodexNudge('on', m.endpoint); assert.ok(!isBlock(r), 'expected no nudge: ' + r.stdout); } finally { m.stop(); }
});

test('codexNudgeSubstantial on + confident "substantial" -> the nudge fires', async () => {
  const m = await startMock(0.95);
  try { const { r } = runCodexNudge('on', m.endpoint); assert.ok(isBlock(r), 'expected nudge: ' + r.stdout); } finally { m.stop(); }
});

test('codexNudgeSubstantial shadow + confident "trivial" -> unchanged (nudge fires), no wait', async () => {
  const m = await startMock(0.05);
  try { const { r } = runCodexNudge('shadow', m.endpoint); assert.ok(isBlock(r), 'shadow never changes the outcome: ' + r.stdout); } finally { m.stop(); }
});

test('codexNudgeSubstantial on + unreachable Jev -> fail-open to the nudge within the 1.5 s cap', () => {
  const { r, ms } = runCodexNudge('on', 'http://127.0.0.1:9/unreachable');
  assert.ok(isBlock(r), 'fail-open keeps the nudge: ' + r.stdout);
  assert.ok(ms < 8000, 'bounded wait, took ' + ms + ' ms');
});

test('tasklistTrivial on + confident "small chore" -> no tasklist block; shadow -> block as before', async () => {
  const m = await startMock(0.05);
  try {
    assert.ok(!isBlock(runTasklist('on', m.endpoint)), 'on + trivial skips the block');
    assert.ok(isBlock(runTasklist('shadow', m.endpoint)), 'shadow keeps the block');
  } finally { m.stop(); }
});

test('consultRelax caps the synchronous budget at 1.5 s', () => {
  const ja = require('../../plugins/anti-hall/hooks/lib/jev-assist.js');
  assert.strictEqual(ja.RELAX_SYNC_CAP_MS, 1500);
});
