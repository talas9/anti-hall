'use strict';
// Codex parity for cost-trim Phase 1 (Stop loops + Jev headless notice). Codex shares the hook
// scripts; these cases pin the Codex-specific behaviour: the reduced tasklist nag (Codex has no
// TaskCreate tool), the per-prompt budget, and the unchanged Jev recommend notice.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const TL = 'tasklist-guard.js';
const TG = 'task-guard.js';
const CODEX = { turn_id: 'turn-1', model: 'gpt-5.6-sol' };

function edit(i) {
  return { type: 'assistant', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', id: 'toolu_e' + i, input: { file_path: '/x/f' + i } }] } };
}
const edits = (n) => Array.from({ length: n }, (_, i) => edit(i));
const todoWrite = (todos) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', id: 'toolu_tw', input: { todos } }] } });
const isBlock = (r) => r.status === 0 && r.json && r.json.decision === 'block';
function stop(h, tp, extra, session) {
  return Object.assign({ hook_event_name: 'Stop', transcript_path: tp, cwd: h.home, session_id: session || 's1' }, extra || {});
}
const SS = (extra) => Object.assign({ hook_event_name: 'SessionStart', session_id: 'j1', cwd: process.cwd(), source: 'startup' }, extra || {});
const noticeOf = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const RECOMMEND = /Recommended: enable Jev/;

test('Codex, no evidence: reduced nag, no TaskCreate demand, <= 450 chars, names progress + history paths', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript(edits(4));
    const r = testHook(TL, stop(h, tp, CODEX), { home: h.home });
    assert.ok(isBlock(r), r.stdout);
    const reason = r.json.reason;
    assert.ok(!/TaskCreate|TaskUpdate|TodoWrite/.test(reason), reason);
    assert.match(reason, /list the open tasks and status in your reply/);
    assert.ok(reason.includes(path.join('.anti-hall', 'progress')) && reason.includes(path.join('.anti-hall', 'history')), reason);
    const body = reason.split('\n').filter((l) => !l.startsWith('Override')).join('\n');
    assert.ok(body.length <= 450, 'reduced nag is ' + body.length + ' chars: ' + body);
  } finally { h.cleanup(); }
});

test('Codex reduced nag blocks at most once per session, even when the signal changes', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript(edits(4));
    assert.ok(isBlock(testHook(TL, stop(h, tp, CODEX), { home: h.home })));
    const tp2 = h.writeTranscript(edits(9)); // different work bucket -> a fresh signal
    const r2 = testHook(TL, stop(h, tp2, CODEX), { home: h.home });
    assert.ok(!isBlock(r2), 'second reduced nag must not block: ' + r2.stdout);
  } finally { h.cleanup(); }
});

test('Codex: task-guard obeys the same budget key', () => {
  const h = makeHome();
  try {
    const t1 = [{ id: '1', content: 'one', status: 'in_progress' }];
    const run = (tasks) => testHook(TG, Object.assign({ hook_event_name: 'Stop', session_id: 'cx', transcript_path: h.writeTranscript([todoWrite(tasks)]), prompt_id: 'P1' }, CODEX), { home: h.home, env: { ANTIHALL_STOP_NAG_BUDGET: '1' } });
    assert.ok(isBlock(run(t1)));
    assert.ok(!isBlock(run([...t1, { id: '2', content: 'two', status: 'pending' }])));
  } finally { h.cleanup(); }
});

test('jev recommend notice: a Codex payload is unchanged even with a leaked sdk-cli entrypoint', () => {
  const h = makeHome();
  try {
    const r = testHook('jev-review-reminder.js', SS(CODEX), { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
    assert.match(noticeOf(r), RECOMMEND);
  } finally { h.cleanup(); }
});
