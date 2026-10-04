'use strict';
// Cost-trim Phase 1: Stop loops + Jev headless notice.
//  - tasklist-guard reduced nag only on positive task-tool ABSENCE (Codex, no structural evidence);
//    a Claude session without evidence keeps today's full TaskCreate demand.
//  - guards.stopNagBudgetPerPrompt (default 0 = today's behaviour) for task-guard + tasklist-guard.
//  - jev.recommendNoticeHeadless: the recommend notice is not sent in `claude -p` (sdk-cli) runs.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const SP = require('../../plugins/anti-hall/hooks/lib/stop-policy.js');
const EV = require('../../plugins/anti-hall/hooks/lib/task-tool-evidence.js');

const TL = 'tasklist-guard.js';
const TG = 'task-guard.js';
const CODEX = { turn_id: 'turn-1', model: 'gpt-5.6-sol' };

function edit(i) {
  return { type: 'assistant', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', id: 'toolu_e' + i, input: { file_path: '/x/f' + i } }] } };
}
const edits = (n) => Array.from({ length: n }, (_, i) => edit(i));
const userPrompt = (uuid) => ({ type: 'user', uuid, message: { role: 'user', content: 'do the thing' } });
const toolResultUser = (uuid) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const attachment = (a) => ({ type: 'attachment', attachment: a });
const todoWrite = (todos) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', id: 'toolu_tw', input: { todos } } ] } });

const isBlock = (r) => r.status === 0 && r.json && r.json.decision === 'block';
function stop(h, tp, extra, session) {
  return Object.assign({ hook_event_name: 'Stop', transcript_path: tp, cwd: h.home, session_id: session || 's1' }, extra || {});
}

// ---- evidence parser -------------------------------------------------------
test('evidence: tool_use, deferred_tools attachment naming TaskCreate, task_reminder count', () => {
  const h = makeHome();
  try {
    assert.strictEqual(EV.hasEvidence(h.writeTranscript([todoWrite([])])), true);
    assert.strictEqual(EV.hasEvidence(h.writeTranscript([attachment({ type: 'deferred_tools_delta', addedNames: ['NotebookEdit', 'TaskCreate'] })])), true);
    assert.strictEqual(EV.hasEvidence(h.writeTranscript([attachment({ type: 'task_reminder', content: [] })])), true);
  } finally { h.cleanup(); }
});

test('evidence: substrings and other attachments are NOT evidence (self-confirmation ignored)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([
      { type: 'user', message: { role: 'user', content: 'please call TaskCreate and TodoWrite and task_reminder' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I would use TaskCreate here' }] } },
      attachment({ type: 'hook_success', content: 'Capture the work as tasks via TaskCreate/TaskUpdate' }),
      attachment({ type: 'deferred_tools_delta', addedNames: ['NotebookEdit'] }),
      attachment({ type: 'deferred_tools_delta', removedNames: ['TaskCreate'] }),
    ]);
    assert.strictEqual(EV.hasEvidence(tp), false);
    assert.strictEqual(EV.hasEvidence(path.join(h.home, 'missing.jsonl')), false);
  } finally { h.cleanup(); }
});

// ---- tasklist-guard reduced nag -------------------------------------------
test('Claude, no task-tool evidence: today\'s full TaskCreate demand (no absence inferred)', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript(edits(4));
    const r = testHook(TL, stop(h, tp), { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
    assert.ok(isBlock(r), r.stdout);
    assert.match(r.json.reason, /TaskCreate\/TaskUpdate/);
  } finally { h.cleanup(); }
});

test('Codex WITH structural evidence (deferred_tools attachment naming TaskCreate): full demand', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([attachment({ type: 'deferred_tools_delta', addedNames: ['TaskCreate'] }), ...edits(4)]);
    const r = testHook(TL, stop(h, tp, CODEX), { home: h.home });
    assert.ok(isBlock(r), r.stdout);
    assert.ok(!/list the open tasks and status in your reply/.test(r.json.reason), r.json.reason);
  } finally { h.cleanup(); }
});

test('Codex: the guard\'s own text in the transcript does not count as evidence', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript([attachment({ type: 'hook_success', content: 'Capture the work as tasks via TaskCreate/TaskUpdate' }), ...edits(4)]);
    const r = testHook(TL, stop(h, tp, CODEX), { home: h.home });
    assert.ok(isBlock(r), r.stdout);
    assert.match(r.json.reason, /list the open tasks and status in your reply/);
  } finally { h.cleanup(); }
});

test('guards.tasklistNoTaskTools: full restores the full demand on Codex; skip never nags; protocolLevel=full flips the default', () => {
  const h = makeHome();
  try {
    const tp = h.writeTranscript(edits(4));
    const full = testHook(TL, stop(h, tp, CODEX, 'a'), { home: h.home, env: { ANTIHALL_TASKLIST_NO_TASK_TOOLS: 'full' } });
    assert.ok(isBlock(full)); assert.ok(!/list the open tasks and status in your reply/.test(full.json.reason));
    const skip = testHook(TL, stop(h, tp, CODEX, 'b'), { home: h.home, env: { ANTIHALL_TASKLIST_NO_TASK_TOOLS: 'skip' } });
    assert.ok(!isBlock(skip), skip.stdout);
    const pl = testHook(TL, stop(h, tp, CODEX, 'c'), { home: h.home, env: { ANTIHALL_PROTOCOL_LEVEL: 'full' } });
    assert.ok(isBlock(pl)); assert.ok(!/list the open tasks and status in your reply/.test(pl.json.reason));
    // an explicit value wins over protocolLevel=full
    const ex = testHook(TL, stop(h, tp, CODEX, 'd'), { home: h.home, env: { ANTIHALL_PROTOCOL_LEVEL: 'full', ANTIHALL_TASKLIST_NO_TASK_TOOLS: 'reduced' } });
    assert.match(ex.json.reason, /list the open tasks and status in your reply/);
  } finally { h.cleanup(); }
});

// ---- per-prompt budget -----------------------------------------------------
test('stop-policy: promptKey prefers prompt_id, else the last REAL user entry uuid', () => {
  const h = makeHome();
  try {
    assert.strictEqual(SP.promptKey({ prompt_id: 'p-1' }, null), 'p-1');
    const tp = h.writeTranscript([userPrompt('u-1'), ...edits(1), toolResultUser('u-2')]);
    assert.strictEqual(SP.promptKey({}, tp), 'u-1');
    assert.strictEqual(SP.promptKey({}, path.join(h.home, 'nope.jsonl')), null);
  } finally { h.cleanup(); }
});

test('stop-policy: consumePrompt counts per prompt key and restarts on a new prompt', () => {
  const h = makeHome();
  try {
    assert.strictEqual(SP.consumePrompt(h.home, 's', 'g', 'k1', 2).block, true);
    assert.strictEqual(SP.consumePrompt(h.home, 's', 'g', 'k1', 2).block, true);
    assert.strictEqual(SP.consumePrompt(h.home, 's', 'g', 'k1', 2).block, false);
    assert.strictEqual(SP.consumePrompt(h.home, 's', 'g', 'k2', 2).block, true);
    assert.strictEqual(SP.consumePrompt(h.home, 's', 'other-hook', 'k2', 2).block, true);
  } finally { h.cleanup(); }
});

test('tasklist-guard: default budget (0) keeps today\'s behaviour: a changed signal re-blocks within one prompt', () => {
  const h = makeHome();
  try {
    const p = { prompt_id: 'P1' };
    assert.ok(isBlock(testHook(TL, stop(h, h.writeTranscript(edits(4)), p), { home: h.home })));
    assert.ok(isBlock(testHook(TL, stop(h, h.writeTranscript(edits(7)), p), { home: h.home })));
  } finally { h.cleanup(); }
});

test('tasklist-guard: stopNagBudgetPerPrompt=1 caps blocks per prompt; a new prompt re-arms; session cap stays', () => {
  const h = makeHome();
  try {
    const env = { ANTIHALL_STOP_NAG_BUDGET: '1' };
    assert.ok(isBlock(testHook(TL, stop(h, h.writeTranscript(edits(4)), { prompt_id: 'P1' }), { home: h.home, env })));
    const second = testHook(TL, stop(h, h.writeTranscript(edits(7)), { prompt_id: 'P1' }), { home: h.home, env });
    assert.ok(!isBlock(second), 'budget spent: ' + second.stdout);
    assert.ok(isBlock(testHook(TL, stop(h, h.writeTranscript(edits(10)), { prompt_id: 'P2' }), { home: h.home, env })));
  } finally { h.cleanup(); }
});

test('tasklist-guard: budget falls back to the last user entry uuid when the payload has no prompt_id', () => {
  const h = makeHome();
  try {
    const env = { ANTIHALL_STOP_NAG_BUDGET: '1' };
    assert.ok(isBlock(testHook(TL, stop(h, h.writeTranscript([userPrompt('u-A'), ...edits(4)])), { home: h.home, env })));
    assert.ok(!isBlock(testHook(TL, stop(h, h.writeTranscript([userPrompt('u-A'), ...edits(7)])), { home: h.home, env })));
    assert.ok(isBlock(testHook(TL, stop(h, h.writeTranscript([userPrompt('u-A'), ...edits(7), userPrompt('u-B'), ...edits(3)])), { home: h.home, env })));
  } finally { h.cleanup(); }
});

test('task-guard: stopNagBudgetPerPrompt=1 caps blocks per prompt, default 0 does not', () => {
  const h = makeHome();
  try {
    const tasks1 = [{ id: '1', content: 'one', status: 'in_progress' }];
    const tasks2 = [...tasks1, { id: '2', content: 'two', status: 'pending' }];
    const run = (tasks, extra, env, session) => testHook(TG, Object.assign({ hook_event_name: 'Stop', session_id: session, transcript_path: h.writeTranscript([todoWrite(tasks)]) }, extra), { home: h.home, env });
    // default: today's behaviour, a changed set re-blocks inside the same prompt
    assert.ok(isBlock(run(tasks1, { prompt_id: 'P1' }, {}, 'd')));
    assert.ok(isBlock(run(tasks2, { prompt_id: 'P1' }, {}, 'd')));
    // budget 1
    const env = { ANTIHALL_STOP_NAG_BUDGET: '1' };
    assert.ok(isBlock(run(tasks1, { prompt_id: 'P1' }, env, 'b')));
    assert.ok(!isBlock(run(tasks2, { prompt_id: 'P1' }, env, 'b')));
    assert.ok(isBlock(run([...tasks2, { id: '3', content: 'three', status: 'pending' }], { prompt_id: 'P2' }, env, 'b')));
  } finally { h.cleanup(); }
});

// ---- Jev headless notice -----------------------------------------------------
const SS = (extra) => Object.assign({ hook_event_name: 'SessionStart', session_id: 'j1', cwd: process.cwd(), source: 'startup' }, extra || {});
const noticeOf = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const RECOMMEND = /Recommended: enable Jev/;

test('jev recommend notice: shown interactively, suppressed under sdk-cli (-p), stamp NOT burned', () => {
  const h = makeHome();
  try {
    const head = testHook('jev-review-reminder.js', SS(), { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
    assert.ok(!RECOMMEND.test(noticeOf(head)), head.stdout);
    assert.ok(!fs.existsSync(path.join(h.home, '.anti-hall', 'state', 'jev-recommend-notice.json')), 'headless run must not write the dedupe stamp');
    const inter = testHook('jev-review-reminder.js', SS(), { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
    assert.match(noticeOf(inter), RECOMMEND);
  } finally { h.cleanup(); }
});

test('jev recommend notice: jev.recommendNoticeHeadless (env) and protocolLevel=full bring it back; explicit false beats protocolLevel', () => {
  const h = makeHome();
  try {
    const sdk = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };
    assert.match(noticeOf(testHook('jev-review-reminder.js', SS(), { home: h.home, env: { ...sdk, ANTIHALL_JEV_NOTICE_HEADLESS: '1' } })), RECOMMEND);
    fs.rmSync(path.join(h.home, '.anti-hall', 'state'), { recursive: true, force: true });
    assert.match(noticeOf(testHook('jev-review-reminder.js', SS(), { home: h.home, env: { ...sdk, ANTIHALL_PROTOCOL_LEVEL: 'full' } })), RECOMMEND);
    fs.rmSync(path.join(h.home, '.anti-hall', 'state'), { recursive: true, force: true });
    assert.ok(!RECOMMEND.test(noticeOf(testHook('jev-review-reminder.js', SS(), { home: h.home, env: { ...sdk, ANTIHALL_PROTOCOL_LEVEL: 'full', ANTIHALL_JEV_NOTICE_HEADLESS: '0' } }))));
  } finally { h.cleanup(); }
});

test('JEV REVIEW DUE is still emitted in a headless run while the recommend notice is suppressed', () => {
  const h = makeHome();
  try {
    const dir = path.join(h.home, '.anti-hall');
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'jev.json'), JSON.stringify({ enabled: true, integrations: { modelRouting: 'shadow' } }));
    const ts = new Date(Date.now() - 10 * 86400000).toISOString();
    fs.writeFileSync(path.join(dir, 'logs', 'jev-assist.ndjson'),
      Array.from({ length: 40 }, (_, i) => JSON.stringify({ ts, id: 'modelRouting', h: 'h' + i, base: true, jev: true, conf: 0.9, ms: 10, backend: 'jev', final: true, changed: null, cached: false, mode: 'shadow' })).join('\n') + '\n');
    const r = testHook('jev-review-reminder.js', SS(), { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
    assert.match(noticeOf(r), /jev-review: review due/);
  } finally { h.cleanup(); }
});

// Plan rev 7 (A12/C1): neither guard reads stop_hook_active; a continuation Stop is still evaluated.
test('stop_hook_active:true is still evaluated by tasklist-guard and task-guard (Claude and Codex payloads)', () => {
  for (const [name, extra] of [['claude', {}], ['codex', CODEX]]) {
    const h = makeHome();
    try {
      const a = testHook(TL, stop(h, h.writeTranscript(edits(4)), Object.assign({ stop_hook_active: true }, extra), 'sa-' + name), { home: h.home });
      assert.ok(isBlock(a), name + ' tasklist-guard: ' + a.stdout);
      const tasks = [{ id: '1', content: 'one', status: 'in_progress' }];
      const b = testHook(TG, Object.assign({ hook_event_name: 'Stop', session_id: 'sb-' + name, stop_hook_active: true, transcript_path: h.writeTranscript([todoWrite(tasks)]) }, extra), { home: h.home });
      assert.ok(isBlock(b), name + ' task-guard: ' + b.stdout);
    } finally { h.cleanup(); }
  }
});
