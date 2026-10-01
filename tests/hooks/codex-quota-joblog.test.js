'use strict';
// A codex:codex-rescue that returns only a BACKGROUND job id never shows the usage-limit
// error to codex-quota-detect (PostToolUse); it is only in the codex-companion job log.
// lib/codex-quota.js scanJobLogs folds it into the quota record; SessionStart
// (codex-availability) and the Stop nudge both run it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const QUOTA = require('../../plugins/anti-hall/hooks/lib/codex-quota.js');
const LIMIT = "Codex error: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ";

function writeLog(home, repo, name, body, mtimeMs) {
  const dir = path.join(home, '.claude', 'plugins', 'data', 'codex-openai-codex', 'state', repo, 'jobs');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  if (mtimeMs) { const t = new Date(mtimeMs); fs.utimesSync(f, t, t); }
  return f;
}
const futureStr = (ms) => {
  const d = new Date(Date.now() + ms);
  const mon = d.toLocaleString('en-US', { month: 'short' });
  return `${mon} ${d.getDate()}th, ${d.getFullYear()} ${d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
};

test('scanJobLogs: recent usage-limit log with a future "try again at" is recorded', () => {
  const h = makeHome();
  try {
    writeLog(h.home, 'repo-1', 'task-a.log', '[2026-10-02T10:00:00Z] Starting\n[2026-10-02T10:01:00Z] ' + LIMIT + futureStr(3 * 3600e3) + '.\nTurn failed.\n');
    const hit = QUOTA.scanJobLogs({ home: h.home });
    assert.ok(hit && hit.until > Date.now(), 'hit with future until');
    const q = QUOTA.readQuota({ home: h.home });
    assert.strictEqual(q.exhausted, true);
    assert.ok(Math.abs(q.until - hit.until) < 1000);
  } finally { h.cleanup(); }
});

test('scanJobLogs: stale (past date), old-mtime, unrelated, and missing dirs record nothing', () => {
  const h = makeHome();
  try {
    assert.strictEqual(QUOTA.scanJobLogs({ home: h.home }), null); // no dir at all
    writeLog(h.home, 'r', 'past.log', LIMIT + 'Jul 29th, 2026 3:17 AM.\n');
    writeLog(h.home, 'r', 'old.log', LIMIT + futureStr(3 * 3600e3) + '.\n', Date.now() - 48 * 3600e3);
    writeLog(h.home, 'r', 'other.log', 'Codex error: model not supported\nTurn failed.\n');
    assert.strictEqual(QUOTA.scanJobLogs({ home: h.home }), null);
    assert.strictEqual(QUOTA.readQuota({ home: h.home }).exhausted, false);
  } finally { h.cleanup(); }
});

test('scanJobLogs: only the TAIL bytes are scanned (a limit message buried far above is ignored)', () => {
  const h = makeHome();
  try {
    writeLog(h.home, 'r', 'big.log', LIMIT + futureStr(3 * 3600e3) + '.\n' + 'x\n'.repeat(20000));
    assert.strictEqual(QUOTA.scanJobLogs({ home: h.home }), null);
  } finally { h.cleanup(); }
});

test('SessionStart codex-availability: job-log usage limit surfaces the quota note', () => {
  const h = makeHome();
  try {
    writeLog(h.home, 'repo-1', 'task-a.log', LIMIT + futureStr(3 * 3600e3) + '.\nTurn failed.\n');
    const r = testHook('codex-availability.js', {}, { home: h.home, env: { PATH: '/nonexistent' } });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /Codex unavailable until/);
    assert.strictEqual(QUOTA.readQuota({ home: h.home }).exhausted, true);
  } finally { h.cleanup(); }
});

test('Stop codex-nudge: job-log usage limit suppresses the nudge; without the log it nudges', () => {
  const edits = ['a.ts', 'b.ts', 'c.py'].map((f) => ({ name: 'Edit', input: { file_path: '/x/' + f } }));
  const tl = { type: 'assistant', message: { role: 'assistant', content: edits.map((t, i) => ({ type: 'tool_use', name: t.name, id: 'tu' + i, input: t.input })) } };
  const h = makeHome();
  try {
    const tp = h.writeTranscript([tl]);
    const pl = { hook_event_name: 'Stop', transcript_path: tp, session_id: 't' };
    const before = testHook('codex-nudge.js', pl, { home: h.home });
    assert.ok(before.json && before.json.decision === 'block', 'nudges without a limit log: ' + before.stdout);
  } finally { h.cleanup(); }
  const h2 = makeHome();
  try {
    writeLog(h2.home, 'repo-1', 'task-a.log', LIMIT + futureStr(3 * 3600e3) + '.\nTurn failed.\n');
    const tp = h2.writeTranscript([tl]);
    const r = testHook('codex-nudge.js', { hook_event_name: 'Stop', transcript_path: tp, session_id: 't' }, { home: h2.home });
    assert.ok(!(r.json && r.json.decision === 'block'), 'suppressed: ' + r.stdout);
  } finally { h2.cleanup(); }
});
