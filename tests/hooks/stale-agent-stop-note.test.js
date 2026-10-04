'use strict';
// stale-agent-stop-note (PreToolUse TaskStop, advisory only): one line when the
// agent being stopped was sent a message / resumed after its last report and
// has not reported since. Every spawn uses an isolated HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const { spawn, send, idle, stop } = require('../helpers/teammate-fixtures.js');

const HOOK = 'stale-agent-stop-note.js';
const NAME = 'rel-worker';
const ago = (min) => new Date(Date.now() - min * 60 * 1000).toISOString();
const payload = (tp, taskId) => ({ hook_event_name: 'PreToolUse', tool_name: 'TaskStop', tool_input: { task_id: taskId }, transcript_path: tp, session_id: 't' });
const ctx = (r) => (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
const silent = (r) => r.status === 0 && !String(r.stdout || '').trim();

// The field order: spawn, the teammate's turn ends, the coordinator sends a
// message, the earlier report is recorded, then the coordinator calls TaskStop
// (present in the transcript, unanswered, when the hook runs).
const fieldCase = () => [spawn(NAME, ago(120)), send(NAME, ago(99)), idle(NAME, ago(105), ago(98)), stop(NAME, ago(0), { answered: false })].flat();

function run(entries, taskId, env) {
  const h = makeHome();
  try { return testHook(HOOK, payload(h.writeTranscript(entries), taskId), { home: h.home, env: env || {} }); } finally { h.cleanup(); }
}

test('FIELD CASE: TaskStop on a teammate sent a message after its last report -> one advisory line, never a decision', () => {
  const r = run(fieldCase(), NAME);
  assert.strictEqual(r.status, 0);
  assert.match(ctx(r), /stale-stop: "rel-worker" was sent a message at \d\d:\d\d UTC, after its last report \(\d\d:\d\d UTC\), and has not reported since/);
  assert.ok(ctx(r).split('\n').length <= 4, 'short shaped message');
  assert.strictEqual(r.json.decision, undefined);
  assert.strictEqual(r.json.hookSpecificOutput.permissionDecision, undefined);
  assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('stopped by its <name>@<team> agent id -> same note', () => {
  assert.match(ctx(run(fieldCase().slice(0, -1).concat(stop(NAME + '@session-fx', ago(0), { answered: false })), NAME + '@session-fx')), /stale-stop: "rel-worker"/);
});

test('teammate that reported after the message -> silent', () => {
  const e = [spawn(NAME, ago(120)), idle(NAME, ago(105), ago(104)), send(NAME, ago(99)), idle(NAME, ago(50), ago(49)), stop(NAME, ago(0), { answered: false })].flat();
  assert.ok(silent(run(e, NAME)));
});

test('teammate never sent a message, unknown id, other tool, no transcript -> silent', () => {
  const e = [spawn(NAME, ago(120)), idle(NAME, ago(105), ago(104)), stop(NAME, ago(0), { answered: false })].flat();
  assert.ok(silent(run(e, NAME)));
  assert.ok(silent(run(fieldCase(), 'someone-else')));
  const h = makeHome();
  try {
    const tp = h.writeTranscript(fieldCase());
    assert.ok(silent(testHook(HOOK, Object.assign(payload(tp, NAME), { tool_name: 'Bash' }), { home: h.home })));
    assert.ok(silent(testHook(HOOK, payload(h.home + '/missing.jsonl', NAME), { home: h.home })));
    assert.ok(silent(testHookRaw(HOOK, '{not json', { home: h.home })));
  } finally { h.cleanup(); }
});

test('background agent resumed after its last report -> note; finished after the resume -> silent', () => {
  const ID = 'dddd111122223333e';
  const launch = { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_l', type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: ' + ID + '\noutput_file: /nonexistent/x.output' }] }] }, timestamp: ago(120) };
  const notif = (ts) => ({ type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>' + ID + '</task-id>\n<status>completed</status>\n</task-notification>' }, timestamp: ts });
  const resume = { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_r', type: 'tool_result', content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Resuming agent ' + ID.slice(0, 7), resumedAgentId: ID }) }] }] }, timestamp: ago(60) };
  const s = stop(ID, ago(0), { answered: false });
  assert.match(ctx(run([launch, notif(ago(90)), resume, ...s], ID)), /stale-stop: "dddd111122223333e" was resumed at \d\d:\d\d UTC, after its last report/);
  assert.ok(silent(run([launch, notif(ago(90)), resume, notif(ago(30)), ...s], ID)));
  assert.ok(silent(run([launch, ...s], ID)), 'never resumed: an ordinary stop of a running agent');
});

test('SETTING OFF: env and settings file each silence the same fixture', () => {
  assert.ok(silent(run(fieldCase(), NAME, { ANTIHALL_STALE_AGENT_STOP_NOTE: 'off' })));
  const h = makeHome();
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify({ guards: { staleAgentStopNote: false } }));
    assert.ok(silent(testHook(HOOK, payload(h.writeTranscript(fieldCase()), NAME), { home: h.home })));
  } finally { h.cleanup(); }
});
